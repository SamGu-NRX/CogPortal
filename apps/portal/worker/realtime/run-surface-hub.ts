import { DurableObject } from "cloudflare:workers";
import { RunSurfaceSnapshotSchema, shouldReplaceRunSurfaceSnapshot, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { DiscordRequestError, syncRunSurfaceMessage } from "../services/discord-messages";
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
      // A publication is the only thing that lifts a delivery refusal: see alarm().
      if (publish) {
        await this.ctx.storage.put("publications", (await this.ctx.storage.get<number>("publications") ?? 0) + 1);
      }
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
    let read: { snapshot: RunSurfaceSnapshot; publication: number; refused: boolean } | null;
    try {
      read = await this.serialize(async () => {
        try {
          const snapshot = await this.readAndBroadcast(surfaceId);
          const publication = await this.ctx.storage.get<number>("publications") ?? 0;
          const refused = await this.ctx.storage.get<number>("deliveryRefused") === publication;
          return { snapshot, publication, refused };
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
    // A refused message is not retried on every tick: the run still ticks for
    // the website and lost-contact detection, but Discord is asked again only
    // after the next publication. Recording the publication the read saw,
    // rather than a flag, lets one that lands mid-request still get its try.
    // Without a bot token (local development) nothing can be sent at all.
    if (!read.refused && this.env.DISCORD_BOT_TOKEN) {
      try {
        await syncRunSurfaceMessage(this.env, read.snapshot);
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
        await this.ctx.storage.put("deliveryRefused", read.publication);
      }
    }
    if (ticking(read.snapshot)) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }
}
