import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { Env } from "../../worker/env.ts";
import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";

// Only Cloudflare's host objects are replaced. Tests use the production hub,
// builder, and database queries, with an explicit queue for the DO input gate.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
      shortCircuit: true,
      format: "module",
    };
    return nextResolve(specifier, context);
  },
});
Object.assign(globalThis, { WebSocketRequestResponsePair: class {} });
const { RunSurfaceHub } = await import("../../worker/realtime/run-surface-hub.ts");
hooks.deregister();

export function runSurfaceHubs(env: Env) {
  const objects = new Map<string, ReturnType<typeof create>>();
  const requests: Array<{ surfaceId: string; operation: string }> = [];
  function create() {
    const values = new Map<string, unknown>();
    const messages: RunSurfaceSnapshot[] = [];
    const gateRejections: unknown[] = [];
    const sockets: Array<{ send(payload: string): void; close(): void }> = [];
    let alarm: number | null = null;
    let serial: Promise<unknown> = Promise.resolve();
    const context = {
      storage: {
        async get(key: string) { return values.get(key); },
        async put(key: string | Record<string, unknown>, value?: unknown) {
          if (typeof key === "string") values.set(key, structuredClone(value));
          else for (const [name, entry] of Object.entries(key)) values.set(name, structuredClone(entry));
        },
        async delete(keys: string[]) { for (const key of keys) values.delete(key); },
        async getAlarm() { return alarm; },
        async setAlarm(value: number) { alarm = value; },
        async deleteAlarm() { alarm = null; },
        async deleteAll() { values.clear(); },
      },
      setWebSocketAutoResponse() {},
      acceptWebSocket(socket: { send(payload: string): void; close(): void }) { sockets.push(socket); },
      getWebSockets: () => [{ send(payload: string) { messages.push(JSON.parse(payload)); }, close() {} }, ...sockets],
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
        const result = serial.then(callback).catch((error: unknown) => {
          gateRejections.push(error);
          throw new Error("Unexpected gate callback rejection would reset the Durable Object", { cause: error });
        });
        serial = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    // SAFETY: the Node host shim and hub use only the context methods above.
    const createHub = () => new RunSurfaceHub(context as never, env);
    let hub = createHub();
    return {
      messages,
      values,
      gateRejections,
      get scheduledAlarm() { return alarm; },
      restart() { hub = createHub(); },
      async fetch(request: Request) {
        try { return await hub.fetch(request); }
        finally { assert.deepEqual(gateRejections, [], "fetch must not reject a gate callback"); }
      },
      async alarm() {
        try { await hub.alarm(); }
        finally { assert.deepEqual(gateRejections, [], "alarm must not reject a gate callback"); }
      },
    };
  }
  function get(surfaceId: string) {
    let object = objects.get(surfaceId);
    if (!object) { object = create(); objects.set(surfaceId, object); }
    return object;
  }
  // SAFETY: snapshot callers use only idFromName and the stub's fetch method.
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (url: string, init: RequestInit) => {
        requests.push({ surfaceId: id, operation: new URL(url).pathname });
        return get(id).fetch(new Request(url, init));
      },
    }),
  } as unknown as Env["RUN_SURFACES"];
  return { namespace, get, requests };
}
