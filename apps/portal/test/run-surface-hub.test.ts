import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { RunSurfaceSnapshotSchema, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";

// Node supplies neither the Durable Object base nor its ping/pong pair. Keep
// those environment stand-ins separate from the real hub and snapshot guard.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});
Object.assign(globalThis, {
  WebSocketRequestResponsePair: class {
    constructor(public request: string, public response: string) {}
  },
});
const { RunSurfaceHub } = await import("../worker/realtime/run-surface-hub.ts");
hooks.deregister();

function snapshot(generation: number, status: RunSurfaceSnapshot["status"], updatedAt: number): RunSurfaceSnapshot {
  return RunSurfaceSnapshotSchema.parse({
    id: "surface_0123456789abcdef0123",
    team: { id: "team_test", name: "Test team" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    branch: "main",
    dirty: false,
    stage: "hosted",
    status,
    phase: status === "running" ? "evaluating" : status,
    createdAt: 1_780_000_000_000,
    updatedAt,
    finishedAt: status === "running" ? null : updatedAt,
    elapsedMs: 1_000,
    progress: null,
    primaryMetric: null,
    localRunId: null,
    practiceRunId: `run_generation_${generation}`,
    officialRunId: null,
    executionGeneration: generation,
    published: false,
    nextOfficialAttempt: null,
    events: [],
    actions: ["open_portal"],
    simulated: true,
  });
}

function harness() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const messages: string[][] = [[], []];
  const alarms: number[] = [];
  let alarm: number | null = null;
  let serial: Promise<unknown> = Promise.resolve();
  const context = {
    storage: {
      async get(key: string) { return values.get(key); },
      async put(key: string, value: string) {
        writes.push(key);
        values.set(key, structuredClone(value));
      },
      async getAlarm() { return alarm; },
      async setAlarm(value: number) { alarm = value; alarms.push(value); },
    },
    setWebSocketAutoResponse(pair: { request: string; response: string }) {
      assert.equal(pair.request, "ping");
      assert.equal(pair.response, "pong");
    },
    getWebSockets: () => messages.map((sent) => ({ send: (payload: string) => sent.push(payload) })),
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = serial.then(callback);
      serial = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  // SAFETY: /publish uses only the context methods above and no Env bindings.
  // The Node base-class shim supplies those methods instead of Cloudflare.
  const createHub = () => new RunSurfaceHub(context as never, {} as never);
  let hub = createHub();
  return {
    writes,
    alarms,
    messages,
    restart() { hub = createHub(); },
    async publish(value: RunSurfaceSnapshot) {
      const response = await hub.fetch(new Request("https://run-surface.internal/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(values.get("surfaceId"), value.id);
    },
    assertDelivered(...expected: RunSurfaceSnapshot[]) {
      const latest = values.get("latest");
      assert.ok(latest);
      assert.deepEqual(JSON.parse(latest), expected.at(-1));
      for (const sent of messages) assert.deepEqual(sent.map((payload) => JSON.parse(payload)), expected);
      assert.equal(writes.filter((key) => key === "latest").length, expected.length);
      assert.ok(alarms.length > 0, "accepted publications must schedule an alarm");
    },
  };
}

const NOW = 1_780_000_001_000;

test("hub keeps generation N+1 cached and broadcast when a later-dated N arrives", async () => {
  const h = harness();
  const current = snapshot(2, "running", NOW);
  await h.publish(current);
  h.restart();
  const alarmsBefore = h.alarms.length;
  await h.publish(snapshot(1, "failed", NOW + 10_000));
  h.assertDelivered(current);
  assert.equal(h.alarms.length, alarmsBefore, "a rejected publication must not reschedule the alarm");
});

test("hub accepts a higher-generation retry with the same timestamp as its terminal predecessor", async () => {
  const h = harness();
  const failed = snapshot(1, "failed", NOW);
  const retry = snapshot(2, "running", NOW);
  await h.publish(failed);
  await h.publish(retry);
  h.assertDelivered(failed, retry);
});

test("hub refuses same-generation terminal to running regression even with a newer timestamp", async () => {
  const h = harness();
  const terminal = snapshot(2, "failed", NOW);
  await h.publish(terminal);
  const alarmsBefore = h.alarms.length;
  await h.publish(snapshot(2, "running", NOW + 1_000));
  h.assertDelivered(terminal);
  assert.equal(h.alarms.length, alarmsBefore);
});

test("hub stores and broadcasts later findings for the same terminal generation", async () => {
  const h = harness();
  const terminal = snapshot(2, "failed", NOW);
  const findings: RunSurfaceSnapshot = {
    ...terminal,
    updatedAt: NOW + 1_000,
    refusalHeadline: "embed_text returned a one-dimensional array; expected a matrix.",
  };
  await h.publish(terminal);
  await h.publish(findings);
  h.assertDelivered(terminal, findings);
});
