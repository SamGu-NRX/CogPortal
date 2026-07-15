import { DurableObject } from "cloudflare:workers";
import { RunSurfaceSnapshotSchema, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { DiscordRequestError, syncRunSurfaceMessage } from "../services/discord-messages";
import { buildRunSurfaceSnapshot } from "../services/run-surfaces";

const TICK_MS = 2_000;

export class RunSurfaceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async broadcast(snapshot: RunSurfaceSnapshot): Promise<void> {
    const payload = JSON.stringify(snapshot);
    await this.ctx.storage.put("latest", payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A subsequent hibernation callback will clean up the closed socket.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") {
      const snapshot = RunSurfaceSnapshotSchema.parse(await request.json());
      await this.ctx.storage.put("surfaceId", snapshot.id);
      await this.broadcast(snapshot);
      const currentAlarm = await this.ctx.storage.getAlarm();
      const next = Date.now() + (snapshot.status === "running" ? 250 : 1);
      if (currentAlarm == null || next < currentAlarm) await this.ctx.storage.setAlarm(next);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/connect" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const latest = await this.ctx.storage.get<string>("latest");
      if (latest) server.send(latest);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const surfaceId = await this.ctx.storage.get<string>("surfaceId");
    if (!surfaceId) return;
    let snapshot: RunSurfaceSnapshot;
    try {
      snapshot = await buildRunSurfaceSnapshot(this.env, surfaceId);
      await this.broadcast(snapshot);
      await syncRunSurfaceMessage(this.env, snapshot);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 404) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        for (const socket of this.ctx.getWebSockets()) {
          try {
            socket.close(1000, "Run surface no longer exists");
          } catch {
            // The socket was already closed while the alarm was running.
          }
        }
        return;
      }
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
