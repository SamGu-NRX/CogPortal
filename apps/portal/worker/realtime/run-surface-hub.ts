import { DurableObject } from "cloudflare:workers";
import { RunSurfaceSnapshotSchema, shouldReplaceRunSurfaceSnapshot, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { DiscordRequestError, runSurfaceDiscordChannel, syncRunSurfaceMessage } from "../services/discord-messages";
import { readRunSurfaceSnapshot } from "../services/run-surfaces";

const TICK_MS = 2_000;

/** Whether ticking can show anything new. A silent local run changes only
 *  when its CLI reports again, and that report publishes and restarts the
 *  tick, so polling it would rewrite the same Discord message forever. */
function ticking(snapshot: RunSurfaceSnapshot): boolean {
  return snapshot.status === "running" && snapshot.silentSince === null;
}

/** Whether Discord refused the request itself, so a retry gets the same
 *  answer: any 4xx but 429 (401 token, 403 channel permission, 404 channel
 *  gone; a deleted message was already reposted by `syncRunSurfaceMessage`).
 *  Discord temporarily blocks an IP after 10,000 requests answered 401, 403
 *  or 429 in ten minutes, and every team's messages are sent from this
 *  Worker. */
function refusedByDiscord(error: unknown): error is DiscordRequestError {
  return error instanceof DiscordRequestError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

/**
 * How long a refused channel waits before Discord is asked again, when
 * nothing that could change the answer has happened.
 *
 * Derived from Discord's documented limit (10,000 refused requests per IP in
 * ten minutes, shared by every team's messages), not from a measurement: at
 * one retry per refused surface per five minutes, it takes 5,000 surfaces
 * refused at once to reach that limit, and a channel whose permission comes
 * back mid-run is written to again within five minutes.
 */
const REFUSED_RETRY_MS = 5 * 60_000;

/** What Discord refused: the channel, the run's status then, and when. A
 *  number is the record an older hub kept, which this one retries once. */
type DeliveryRefusal = { channel: string | null; status: RunSurfaceSnapshot["status"]; at: number };

export class RunSurfaceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Cloudflare resets the object if a gate callback rejects. Return failures
   * as values inside the gate, then let HTTP/alarm handling act outside it. */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { ok: true as const, value: await operation() };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  /** Older writers omitted fields now required by the wire contract.
   * Rebuild unreadable cache entries from the database, losing that cached
   * ordering baseline rather than inventing source eligibility. */
  private readCached(surfaceId: string, stored: string): RunSurfaceSnapshot | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(stored);
    } catch {
      return this.discardCached(surfaceId, "malformed_json", []);
    }
    const parsed = RunSurfaceSnapshotSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
    return this.discardCached(
      surfaceId,
      "schema_mismatch",
      parsed.error.issues.map((issue) => issue.path.join(".")).slice(0, 8),
    );
  }

  /** Field paths only. The payload can carry a team's repository and commit,
   *  so none of it is logged. */
  private discardCached(
    surfaceId: string,
    reason: "malformed_json" | "schema_mismatch",
    fields: string[],
  ): null {
    console.warn(JSON.stringify({ event: "run_surface_cache_discarded", surfaceId, reason, fields }));
    return null;
  }

  /** Call only inside blockConcurrencyWhile, including the database read.
   * The multi-key put atomically commits the payload and its revision. The
   * separate counter survives missing-surface cleanup while clients reconnect. */
  private async readAndBroadcast(surfaceId: string): Promise<RunSurfaceSnapshot> {
    const stored = await this.ctx.storage.get<string>("latest");
    const latest = stored ? this.readCached(surfaceId, stored) : null;
    const candidate = RunSurfaceSnapshotSchema.parse({
      ...await readRunSurfaceSnapshot(this.env, surfaceId),
      snapshotRevision: (await this.ctx.storage.get<number>("snapshotRevision") ?? latest?.snapshotRevision ?? 0) + 1,
    });
    // Separate DB reads can still observe lagging execution data. Keep the
    // generation/terminal guard, but number every returned payload here.
    const snapshot = latest && !shouldReplaceRunSurfaceSnapshot(latest, candidate)
      ? { ...latest, snapshotRevision: candidate.snapshotRevision }
      : candidate;
    const payload = JSON.stringify(snapshot);
    await this.ctx.storage.put({ latest: payload, snapshotRevision: snapshot.snapshotRevision });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A subsequent hibernation callback will clean up the closed socket.
      }
    }
    return snapshot;
  }

  private async snapshot(surfaceId: string, publish: boolean): Promise<RunSurfaceSnapshot> {
    return this.serialize(async () => {
      await this.ctx.storage.put("surfaceId", surfaceId);
      const armBy = async (next: number) => {
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm == null || next < currentAlarm) await this.ctx.storage.setAlarm(next);
      };
      // Armed before the read: a silent run has no tick, so if this read
      // fails, the alarm's own retry is what delivers an accepted result.
      if (publish) await armBy(Date.now() + 250);
      const snapshot = await this.readAndBroadcast(surfaceId);
      if (publish || ticking(snapshot)) await armBy(Date.now() + (ticking(snapshot) ? 250 : 1));
      return snapshot;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/publish" || url.pathname === "/snapshot") && request.method === "POST") {
      const { surfaceId } = await request.json<{ surfaceId: string }>();
      if (!RunSurfaceSnapshotSchema.shape.id.safeParse(surfaceId).success) {
        return new Response("Invalid surface ID", { status: 400 });
      }
      try {
        return Response.json(await this.snapshot(surfaceId, url.pathname === "/publish"));
      } catch (error) {
        if (error instanceof ApiHttpError && error.status === 404) return new Response(error.message, { status: 404 });
        throw error;
      }
    }
    if (url.pathname === "/connect" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.serialize(async () => {
        const surfaceId = url.searchParams.get("surfaceId") ?? await this.ctx.storage.get<string>("surfaceId");
        if (!surfaceId) return new Response("Run surface not found", { status: 404 });
        await this.ctx.storage.put("surfaceId", surfaceId);
        const snapshot = await this.readAndBroadcast(surfaceId);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify(snapshot));
        if (ticking(snapshot) && await this.ctx.storage.getAlarm() == null) {
          await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
        }
        return new Response(null, { status: 101, webSocket: client });
      }).catch((error: unknown) => {
        if (error instanceof ApiHttpError && error.status === 404) return new Response(error.message, { status: 404 });
        throw error;
      });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const surfaceId = await this.ctx.storage.get<string>("surfaceId");
    if (!surfaceId) return;
    const retrySoon = async (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "run_surface_tick_failed",
          surfaceId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    };
    let read: { snapshot: RunSurfaceSnapshot; refusal: DeliveryRefusal | number | undefined } | null;
    try {
      read = await this.serialize(async () => {
        try {
          const snapshot = await this.readAndBroadcast(surfaceId);
          const refusal = await this.ctx.storage.get<DeliveryRefusal | number>("deliveryRefused");
          return { snapshot, refusal };
        } catch (error) {
          if (!(error instanceof ApiHttpError) || error.status !== 404) throw error;
          // Keep the sequence even if context disappears temporarily. Cleanup
          // shares the build lock so it cannot erase a concurrent publication.
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.delete(["latest", "surfaceId"]);
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.close(1000, "Run surface no longer exists");
            } catch {
              // The socket was already closed while the alarm was running.
            }
          }
          return null;
        }
      });
    } catch (error) {
      // A failed read may be hiding an accepted result; keep trying.
      await retrySoon(error);
      return;
    }
    if (!read) return;
    // A refused message is not retried on every tick, nor on every
    // publication: CLI and runner heartbeats publish about every two seconds,
    // so that would ask a refusing channel at the same rate. The run still
    // ticks for the website and lost-contact detection. Discord is asked again
    // when the answer could differ: the surface is bound to another channel,
    // the run's status changed (a handful of times per run, so its result
    // still gets a try), or REFUSED_RETRY_MS has passed. Recording the status
    // the read saw lets a change that lands mid-request still get its try.
    // Without a bot token (local development) nothing can be sent at all.
    if (this.env.DISCORD_BOT_TOKEN && !await this.stillRefused(surfaceId, read.refusal, read.snapshot)) {
      try {
        await syncRunSurfaceMessage(this.env, read.snapshot);
        if (read.refusal !== undefined) await this.ctx.storage.delete(["deliveryRefused"]);
      } catch (error) {
        if (error instanceof DiscordRequestError && error.retryAfterMs) {
          await this.ctx.storage.setAlarm(Date.now() + error.retryAfterMs);
          return;
        }
        if (!refusedByDiscord(error)) {
          await retrySoon(error);
          return;
        }
        console.warn(JSON.stringify({ event: "run_surface_delivery_refused", surfaceId, status: error.status }));
        const refusal: DeliveryRefusal = {
          channel: await runSurfaceDiscordChannel(this.env, surfaceId).catch(() => null),
          status: read.snapshot.status,
          at: Date.now(),
        };
        await this.ctx.storage.put("deliveryRefused", refusal);
      }
    }
    if (ticking(read.snapshot)) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Whether the recorded refusal still answers for this attempt. A binding
   *  that cannot be read keeps the refusal: not knowing is no reason to send. */
  private async stillRefused(
    surfaceId: string,
    refusal: DeliveryRefusal | number | undefined,
    snapshot: RunSurfaceSnapshot,
  ): Promise<boolean> {
    if (refusal === undefined || typeof refusal === "number") return false;
    if (refusal.status !== snapshot.status || Date.now() - refusal.at >= REFUSED_RETRY_MS) return false;
    try {
      return await runSurfaceDiscordChannel(this.env, surfaceId) === refusal.channel;
    } catch {
      return true;
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }
}
