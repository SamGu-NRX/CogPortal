import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunStreamEventSchema,
  type RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import { effectiveDiscordChannelPermissions } from "../worker/services/discord.ts";
import { runSurfaceMessage } from "../worker/services/discord-messages.ts";
import { runnerSurfaceStatusCode } from "../worker/routes/runner-events.ts";

const VIEW_AND_SEND = String((1n << 10n) | (1n << 11n));

test("private team-channel permissions honor role overwrites", () => {
  const permissions = effectiveDiscordChannelPermissions(
    "guild-1",
    "bot-1",
    { user: { id: "bot-1" }, roles: ["bot-role"] },
    [
      { id: "guild-1", permissions: "0" },
      { id: "bot-role", permissions: VIEW_AND_SEND },
    ],
    [
      { id: "guild-1", type: 0, allow: "0", deny: VIEW_AND_SEND },
      { id: "bot-role", type: 0, allow: VIEW_AND_SEND, deny: "0" },
    ],
  );
  assert.equal(permissions & BigInt(VIEW_AND_SEND), BigInt(VIEW_AND_SEND));
});

test("member deny wins after role allows", () => {
  const permissions = effectiveDiscordChannelPermissions(
    "guild-1",
    "bot-1",
    { user: { id: "bot-1" }, roles: ["bot-role"] },
    [
      { id: "guild-1", permissions: "0" },
      { id: "bot-role", permissions: VIEW_AND_SEND },
    ],
    [{ id: "bot-1", type: 1, allow: "0", deny: String(1n << 11n) }],
  );
  assert.equal(permissions & (1n << 10n), 1n << 10n);
  assert.equal(permissions & (1n << 11n), 0n);
});

function snapshot(status: RunSurfaceSnapshot["status"] = "running"): RunSurfaceSnapshot {
  const started = 1_750_000_000_000;
  return {
    id: `surface_${"a".repeat(20)}`,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    dirty: false,
    stage: "local",
    status,
    phase: status === "running" ? "evaluating" : status,
    createdAt: started,
    updatedAt: started + 8_000,
    finishedAt: status === "running" ? null : started + 8_000,
    elapsedMs: 8_000,
    progress: { current: 18, total: 40, unit: "cases" },
    primaryMetric: status === "succeeded" ? {
      key: "accuracy",
      label: "Accuracy",
      value: 0.913,
      unit: null,
      higherIsBetter: true,
      primary: true,
      precision: 3,
    } : null,
    metrics: [],
    teamBest: null,
    localRunId: "localrun_123",
    practiceRunId: null,
    officialRunId: null,
    published: false,
    nextOfficialAttempt: 2,
    events: [0, 1, 2, 3].map((sequence) => ({
      eventId: `stream_event_${sequence}`,
      source: "local" as const,
      sourceRunId: "localrun_123",
      sourceSequence: sequence,
      phase: "evaluating",
      code: sequence ? "evaluation.progress" as const : "repository.ready" as const,
      occurredAt: started + sequence * 2_000,
      elapsedMs: sequence * 2_000,
      progress: sequence ? { current: sequence, total: 40, unit: "cases" as const } : null,
    })),
    actions: ["open_console", "open_portal"],
    simulated: true,
  };
}

function render(value: RunSurfaceSnapshot) {
  return runSurfaceMessage({ PUBLIC_ORIGIN: "https://portal.example" } as never, value);
}

function rendered(value: RunSurfaceSnapshot): string {
  return JSON.stringify(render(value));
}

function textContents(value: RunSurfaceSnapshot): string[] {
  const container = render(value).components[0]!;
  return container.components.flatMap((child: { type: number; content?: string; components?: Array<{ content?: string }> }) =>
    child.type === 10
      ? [child.content ?? ""]
      : child.type === 9
        ? (child.components ?? []).map((inner) => inner.content ?? "")
        : [],
  );
}

function buttonsOf(value: RunSurfaceSnapshot): Array<{ label: string; style: number; custom_id?: string }> {
  const container = render(value).components[0]!;
  return container.components.flatMap((child: { type: number; components?: never[]; accessory?: never }) => {
    if (child.type === 1) return (child.components ?? []) as never[];
    if (child.type === 9 && child.accessory) return [child.accessory] as never[];
    return [] as never[];
  });
}

test("running surface is a multi-step loader with Watch live as the only control", () => {
  const running = rendered(snapshot());
  assert.match(running, /### Vision Recognition/);
  assert.match(running, /\*\*Evaluating\*\*/);
  assert.match(running, /`18\/40`/);
  assert.match(running, /-# Scoring/);
  assert.match(running, /simulated/);
  assert.doesNotMatch(running, /SIMULATED/);
  assert.doesNotMatch(running, / · /);
  const controls = buttonsOf(snapshot());
  assert.deepEqual(controls.map((item) => item.label), ["Watch live"]);
  assert.match(controls[0]!.custom_id ?? "", /:open_console$/);
  assert.match(running, /● local/);
});

test("terminal success recomposes into a decision surface", () => {
  const value = snapshot("succeeded");
  value.actions = ["verify_hosted", "run_again", "open_console", "open_portal"];
  const terminal = rendered(value);
  assert.match(terminal, /Bench clear/);
  assert.match(terminal, /\*\*0\.913\*\*/);
  assert.doesNotMatch(terminal, /Evaluating/);
  assert.doesNotMatch(terminal, /Watch live/);
  assert.match(terminal, /✓ local/);
  const controls = buttonsOf(value);
  assert.deepEqual(
    controls.map((item) => [item.label, item.style]),
    [["Verify hosted", 1], ["Run again", 2], ["Cog*Portal", 5]],
  );
});

test("failure names the phase, points at the terminal, and shows a two-line trace", () => {
  const value = snapshot("failed");
  value.events.push({
    eventId: "stream_event_9",
    source: "local",
    sourceRunId: "localrun_123",
    sourceSequence: 9,
    phase: "evaluating",
    code: "run.failed.runtime",
    occurredAt: value.updatedAt,
    elapsedMs: 8_000,
    progress: null,
  });
  const failed = rendered(value);
  assert.match(failed, /Stopped during evaluation/);
  assert.match(failed, /the useful detail is in your terminal/);
  assert.match(failed, /Evaluation stopped/);
  assert.match(failed, /Contract passed/);
  const accent = render(value).components[0]!.accent_color;
  assert.equal(accent, 0xc63d2f);
});

test("cancelled is a quiet terminal state, not a frozen loader", () => {
  const cancelled = rendered(snapshot("cancelled"));
  assert.match(cancelled, /Cancelled during evaluation/);
  assert.doesNotMatch(cancelled, /\*\*Evaluating\*\*/);
  assert.equal(render(snapshot("cancelled")).components[0]!.accent_color, 0x1c2637);
});

test("dirty local success explains the path to hosted verification", () => {
  const value = snapshot("succeeded");
  value.dirty = true;
  const dirty = rendered(value);
  assert.match(dirty, /workspace has uncommitted changes/);
  assert.match(dirty, /needs a commit and push/);
  assert.deepEqual(buttonsOf(value).map((item) => item.label), ["Cog*Portal"]);
});

test("published closes the lifecycle quietly with the star mark", () => {
  const value = snapshot("succeeded");
  value.stage = "published";
  value.published = true;
  const published = rendered(value);
  assert.match(published, /✳ Published/);
  assert.match(published, /✓ published/);
  assert.doesNotMatch(published, /Bench clear/);
});

test("success shows the subscore breakdown and how it sits against the team best", () => {
  const value = snapshot("succeeded");
  value.stage = "hosted";
  value.practiceRunId = "run_hosted_123";
  value.metrics = [
    { key: "accuracy", label: "Accuracy", value: 0.913, unit: null, higherIsBetter: true, primary: true, precision: 3 },
    { key: "precision", label: "Precision", value: 0.91, unit: null, higherIsBetter: true, primary: false, precision: 2 },
    { key: "recall", label: "Recall", value: 0.88, unit: null, higherIsBetter: true, primary: false, precision: 2 },
  ];
  value.teamBest = { key: "accuracy", label: "Accuracy", value: 0.892, unit: null, higherIsBetter: true, primary: true, precision: 3 };
  const message = rendered(value);
  assert.match(message, /`0\.91`.*▰▰▰▰▱.*precision/);
  assert.match(message, /`0\.88`.*▰▰▰▰▱.*recall/);
  assert.match(message, /a new team best, past 0\.892/);

  value.teamBest = { ...value.teamBest, value: 0.95 };
  assert.match(rendered(value), /team best stays 0\.950/);
});

test("running shows the team best for context and local success never claims a delta", () => {
  const running = snapshot();
  running.teamBest = { key: "accuracy", label: "Accuracy", value: 0.892, unit: null, higherIsBetter: true, primary: true, precision: 3 };
  assert.match(rendered(running), /team best so far 0\.892/);

  const local = snapshot("succeeded");
  local.teamBest = running.teamBest;
  const message = rendered(local);
  assert.match(message, /team best so far 0\.892/);
  assert.doesNotMatch(message, /new team best/);
});

test("hosted running resets the loader instead of inheriting local progress", () => {
  const hosted = snapshot();
  hosted.stage = "hosted";
  hosted.phase = "preparing";
  hosted.practiceRunId = "run_hosted_123";
  hosted.progress = null;
  hosted.events = [
    {
      eventId: "hosted_fetch_123",
      source: "practice",
      sourceRunId: "run_hosted_123",
      sourceSequence: 0,
      phase: "preparing",
      code: "repository.fetching",
      occurredAt: hosted.updatedAt + 2,
      elapsedMs: 0,
      progress: null,
    },
  ];
  const message = rendered(hosted);
  assert.match(message, /\*\*Preparing the bench\*\*/);
  assert.match(message, /hosted practice/);
  assert.doesNotMatch(message, /18\/40/);
  assert.doesNotMatch(message, /Evaluated/);
});

test("every text display fits the aggregate character budget and mentions stay suppressed", () => {
  const value = snapshot();
  value.benchmark.title = "B".repeat(180);
  value.team.name = "T".repeat(180);
  value.actor.name = "A".repeat(120);
  const contents = textContents(value);
  const total = contents.reduce((sum, content) => sum + content.length, 0);
  assert.ok(total <= 4_000, `aggregate text ${total} exceeds 4000`);
  assert.deepEqual(render(value).allowed_mentions, { parse: [] });
});

test("hosted progress distinguishes evaluation start from a real completed count", () => {
  const base = {
    protocolVersion: "1" as const,
    eventId: "event_run_1_2",
    runId: "run_1",
    sequence: 2,
    occurredAt: Date.now(),
    type: "status" as const,
    status: "evaluating" as const,
    elapsedMs: 2_000,
  };
  assert.equal(
    runnerSurfaceStatusCode({ ...base, progress: { current: 0, total: 40, unit: "cases" } }),
    "evaluation.started",
  );
  assert.equal(
    runnerSurfaceStatusCode({ ...base, progress: { current: 40, total: 40, unit: "cases" } }),
    "evaluation.progress",
  );
});

test("shared event parsing strips raw local detail, paths, predictions, and environment values", () => {
  const secretCanary = "COG_SECRET_CANARY=/Users/student/private predictions=[face-17]";
  const parsed = RunStreamEventSchema.parse({
    eventId: "stream_event_9",
    source: "local",
    sourceRunId: "localrun_123",
    sourceSequence: 9,
    phase: "evaluating",
    code: "run.failed.runtime",
    occurredAt: Date.now(),
    elapsedMs: 4_000,
    progress: null,
    detail: secretCanary,
    stdout: secretCanary,
    predictions: [secretCanary],
  });
  assert.doesNotMatch(JSON.stringify(parsed), /COG_SECRET_CANARY|Users\/student|face-17/);
});
