import { DurableObject } from "cloudflare:workers";
import { RunSurfaceSnapshotSchema, shouldReplaceRunSurfaceSnapshot, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { DiscordRequestError, syncRunSurfaceMessage } from "../services/discord-messages";
import { readRunSurfaceSnapshot } from "../services/run-surfaces";

const TICK_MS = 2_000;

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

  /** Call only inside blockConcurrencyWhile, including the database read.
   * The multi-key put atomically commits the payload and its revision. The
   * separate counter survives missing-surface cleanup while clients reconnect. */
  private async readAndBroadcast(surfaceId: string): Promise<RunSurfaceSnapshot> {
    const stored = await this.ctx.storage.get<string>("latest");
    const latest = stored ? RunSurfaceSnapshotSchema.parse(JSON.parse(stored)) : null;
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
      const snapshot = await this.readAndBroadcast(surfaceId);
      if (publish || snapshot.status === "running") {
        const currentAlarm = await this.ctx.storage.getAlarm();
        const next = Date.now() + (snapshot.status === "running" ? 250 : 1);
        if (currentAlarm == null || next < currentAlarm) await this.ctx.storage.setAlarm(next);
      }
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
        if (snapshot.status === "running" && await this.ctx.storage.getAlarm() == null) {
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
    let snapshot: RunSurfaceSnapshot;
    try {
      const result = await this.serialize(async () => {
        try {
          return await this.readAndBroadcast(surfaceId);
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
      if (!result) return;
      snapshot = result;
      await syncRunSurfaceMessage(this.env, snapshot);
    } catch (error) {
      if (error instanceof DiscordRequestError && error.retryAfterMs) {
        await this.ctx.storage.setAlarm(Date.now() + error.retryAfterMs);
        return;
      }
      console.error(
        JSON.stringify({
          event: "run_surface_tick_failed",
          surfaceId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      return;
    }
    if (snapshot.status === "running") await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }
}
