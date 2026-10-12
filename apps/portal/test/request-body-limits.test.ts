import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { z } from "zod";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  AddTeamMemberRequestSchema,
  AdminAddMemberRequestSchema,
  AdminAddStaffRequestSchema,
  AdminAssignTaRequestSchema,
  AdminCohortPatchSchema,
  ApproveDeviceRequestSchema,
  ChangeTeamRepoRequestSchema,
  ConfirmDiscordLinkRequestSchema,
  ConnectRepoRequestSchema,
  DevLoginRequestSchema,
  JoinCohortRequestSchema,
  JoinTeamRequestSchema,
  LeaveTeamRequestSchema,
  RetryRunRequestSchema,
  RevokeDeviceRequestSchema,
  SelectResultRequestSchema,
  StartPracticeRequestSchema,
  UpdateTeamRequestSchema,
} from "@cogworks/contracts/schema";
import { api } from "../src/lib/api.ts";
import { COGBENCH_SOURCE } from "../src/lib/benchmark-packages.ts";
import type { Database } from "../worker/db/client.ts";
import { benchmarks, cliDevices, cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { BODY_LIMITS, readBodyText } from "../worker/http/respond.ts";
import { registerConnectionRoutes } from "../worker/routes/connections.ts";
import { registerLocalReportRoutes } from "../worker/routes/local-reports.ts";
import { registerLocalRunRoutes } from "../worker/routes/local-runs.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { registerSetupRoutes } from "../worker/routes/setup.ts";
import { sha256Hex } from "../worker/util/crypto.ts";
import { runSurfaceHubs } from "./fixtures/run-surface-hub.ts";

/**
 * Request bodies are counted against a size limit and checked against strict
 * schemas. A real-user test synced a 4 MB report, which the portal stored, and
 * the portal silently dropped fields it didn't declare.
 *
 * Strictness is only safe if every field a real client sends is declared, so
 * the CLI cases replay bodies recorded from each pinned cogbench's own code
 * (fixtures/cli-wire/generate.py) and the SPA cases record what
 * src/lib/api.ts puts on the wire.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");
const WIRE = join(HERE, "fixtures", "cli-wire");
const DEVICE_TOKEN = "cog_bodylimitstoken";

interface Recorded { path: string; body: unknown }
interface WireFixture { pin: string; role: string; requests: Recorded[] }

const wires: WireFixture[] = readdirSync(WIRE)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(WIRE, name), "utf8")) as WireFixture);

function freshDb(): { db: Database; binding: unknown; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: SQLInputValue[] = [];
      const prepared = {
        bind(...params: SQLInputValue[]) {
          bound = params;
          return prepared;
        },
        async run() {
          return { success: true, meta: statement.run(...bound) };
        },
        execute() {
          const results = statement.all(...bound);
          const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
          return { success: true, results, meta: { changes } };
        },
        async all() {
          return { success: true, results: statement.all(...bound) };
        },
        async raw() {
          statement.setReturnArrays(true);
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
    // D1 commits a batch as one transaction.
    async batch(statements: Array<{ execute(): unknown }>) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // SAFETY: the shim implements the statement methods these routes call.
  return { db: drizzle(binding as never), binding, sqlite };
}

async function seed(db: Database): Promise<void> {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_1" });
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null,
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
    repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch, repoId: FIXTURE_REPO.repositoryId,
  });
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "admin" });
  await db.insert(benchmarks).values({
    id: "vision-recognition", version: 1, contractVersion: "cogworks.submissions.v2", entryPointName: "submission",
    title: "Vision Recognition", module: "vision", summary: "fixture", active: true,
    primaryMetricKey: "recognition_score", pluginVersion: "1", datasetVersion: "official-v1",
    scorerVersion: "1", runtimeVersion: "python-3.11", sandboxContract: 1,
  });
  await db.insert(cliDevices).values({
    id: "device_1", userId: "user_1", name: "laptop", tokenHash: await sha256Hex(DEVICE_TOKEN),
    createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, lastUsedAt: null, revokedAt: null,
  });
}

function runtime(binding: unknown): Env {
  // SAFETY: these routes use the D1 shim and the hub assigned below, not ASSETS.
  const env = {
    DB: binding, ENVIRONMENT: "development", DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture", PUBLIC_ORIGIN: "https://portal.example",
  } as Env;
  env.RUN_SURFACES = runSurfaceHubs(env).namespace;
  return env;
}

/** The routes under test, mounted under /api as worker/index.ts mounts them. */
function portal(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  registerConnectionRoutes(routes);
  registerSetupRoutes(routes);
  registerLocalReportRoutes(routes);
  registerLocalRunRoutes(routes);
  registerRunnerEventRoutes(routes);
  const root = new Hono<AppEnv>();
  root.route("/api", routes);
  root.onError(handleError);
  return root;
}

/** These routes must not reach Discord, GitHub or any other host. */
function refuseNetwork(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    throw new Error(`network call in a test: ${String(input)}`);
  });
}

async function world(t: TestContext) {
  refuseNetwork(t);
  const { db, binding, sqlite } = freshDb();
  await seed(db);
  const env = runtime(binding);
  const app = portal();
  // Event routes publish the console after answering; finish that work
  // inside the test that started it.
  const pending: Promise<unknown>[] = [];
  const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} };
  t.after(() => Promise.allSettled(pending));
  // SAFETY: the two methods Hono calls on an ExecutionContext.
  const send = (incoming: Request) => app.fetch(incoming, env, context as never);
  const count = (table: string) =>
    (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { send, sqlite, count };
}

type Framing = "content-length" | "streamed" | "understated";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
        controller.enqueue(bytes.slice(offset, offset + 16 * 1024));
      }
      controller.close();
    },
  });
}

/** A request whose body is framed the way a client could frame it: with an
 *  honest Content-Length, with none (chunked), or with one that lies low. */
function request(path: string, text: string, framing: Framing = "content-length", token = DEVICE_TOKEN): Request {
  const headers = new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
  if (framing === "content-length") headers.set("Content-Length", String(new TextEncoder().encode(text).length));
  if (framing === "understated") headers.set("Content-Length", "64");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: framing === "content-length" ? text : streamOf(text),
    // Node requires this for a stream body.
    duplex: "half",
  } as RequestInit);
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

function wireRequest(wire: WireFixture, test: (path: string) => boolean): Recorded {
  const found = wire.requests.find((entry) => test(entry.path));
  assert.ok(found, `${wire.pin} recorded no such request`);
  return found;
}

const reportSync = (wire: WireFixture) =>
  wireRequest(wire, (path) => path === "/api/v1/local-reports").body as Record<string, unknown>;

/* ── Each installed CLI's real requests still pass ─────────────────────── */

test("every pinned CLI the portal installs has recorded request bodies", () => {
  const pin = /@([0-9a-f]{40})#subdirectory=python\/cogbench/.exec(COGBENCH_SOURCE)?.[1];
  assert.ok(pin, "COGBENCH_SOURCE no longer names a commit");
  assert.ok(
    wires.some((wire) => wire.pin === pin),
    `No recorded bodies for the setup pin ${pin}. Add it to PINS in fixtures/cli-wire/generate.py and run it.`,
  );
});

for (const wire of wires) {
  test(`every request the ${wire.pin.slice(0, 8)} CLI (${wire.role}) sends is accepted`, async (t) => {
    const { send, sqlite } = await world(t);
    const expected = (path: string): number => {
      if (path === "/api/v1/cli/device/token") return 410; // validated, then: no such code
      if (path === "/api/v1/local-reports" || path === "/api/v1/local-runs") return 201;
      return 200;
    };
    // The recording is ordered by path and then sequence, which is an order
    // the CLI itself could send in: each start before its events.
    for (const entry of wire.requests) {
      const response = await send(request(entry.path, JSON.stringify(entry.body)));
      assert.equal(
        response.status,
        expected(entry.path),
        `${entry.path}: ${response.status} ${await response.clone().text()}`,
      );
    }

    // The CLI's capture length is checked and dropped, as zod dropped it
    // before; the stored entry is unchanged.
    const synced = reportSync(wire);
    const stored = sqlite.prepare("SELECT weights_uploaded_json AS json FROM local_reports WHERE report_id = ?")
      .get(synced.reportId as string) as { json: string } | undefined;
    assert.equal(stored?.json, JSON.stringify([{ path: "models/W_embed.npy", sha256: "c".repeat(64) }]));
    assert.deepEqual(
      sqlite.prepare("SELECT status FROM local_run_sessions ORDER BY id").all().map((row) => row.status),
      ["succeeded", "failed"],
    );
  });
}

/* ── Size ──────────────────────────────────────────────────────────────── */

const framings: Framing[] = ["content-length", "streamed", "understated"];

for (const framing of framings) {
  test(`a report over the limit is refused with 413 and not stored (${framing})`, async (t) => {
    const { send, count } = await world(t);
    const report = structuredClone(reportSync(wires[0]!));
    // Valid apart from its size: metric help text has no length cap.
    (report.metrics as Array<Record<string, unknown>>)[0]!.help = "x".repeat(BODY_LIMITS.report);
    const response = await send(request("/api/v1/local-reports", JSON.stringify(report), framing));
    assert.equal(response.status, 413);
    assert.deepEqual(await errorOf(response), {
      code: "invalid_request",
      message: "The request body is over the 1 MiB this endpoint accepts.",
    });
    assert.equal(count("local_reports"), 0);
  });
}

test("a live-run batch over the limit is refused with 413 and records nothing", async (t) => {
  const { send, count } = await world(t);
  const wire = wires[0]!;
  const start = wireRequest(wire, (path) => path === "/api/v1/local-runs");
  assert.equal((await send(request(start.path, JSON.stringify(start.body)))).status, 201);
  const batch = structuredClone(wireRequest(wire, (path) => path.endsWith("/events/batch")));
  const events = (batch.body as { events: Array<Record<string, unknown>> }).events;
  const completed = events.at(-1)!.report as { metrics: Array<Record<string, unknown>> };
  completed.metrics[0]!.help = "x".repeat(BODY_LIMITS.report);
  const before = count("run_stream_events");

  const response = await send(request(batch.path, JSON.stringify(batch.body), "streamed"));
  assert.equal(response.status, 413);
  assert.equal(count("run_stream_events"), before);
  assert.equal(count("local_reports"), 0);
});

test("a runner callback over the limit is refused with 413 before its signature is read", async (t) => {
  const { send, count } = await world(t);
  const response = await send(
    request("/api/internal/v1/runner/events", JSON.stringify({ padding: "x".repeat(BODY_LIMITS.report) }), "streamed"),
  );
  assert.equal(response.status, 413);
  assert.equal(count("run_events"), 0);
});

test("a control body over 64 KiB is refused with 413", async (t) => {
  const { send, count } = await world(t);
  const response = await send(
    request("/api/v1/cli/setup/checks", JSON.stringify({ checks: ["clone"], pad: "x".repeat(BODY_LIMITS.control) }), "streamed"),
  );
  assert.equal(response.status, 413);
  assert.equal((await errorOf(response)).message, "The request body is over the 64 KiB this endpoint accepts.");
  assert.equal(count("setup_verifications"), 0);
});

test("the limit counts bytes, accepts a body exactly at it and refuses one byte more", async () => {
  const app = new Hono<AppEnv>();
  app.post("/echo", async (c) => c.text(String((await readBodyText(c, "control")).length)));
  app.onError(handleError);
  const env = { ENVIRONMENT: "development" } as Env;
  const max = BODY_LIMITS.control;
  const send = (text: string) => app.fetch(request("/echo", text, "streamed"), env);

  const exact = await send("a".repeat(max));
  assert.equal(exact.status, 200);
  assert.equal(await exact.text(), String(max));
  assert.equal((await send("a".repeat(max + 1))).status, 413);
  // Two bytes each in UTF-8: half as many characters already fill the limit.
  assert.equal((await send("é".repeat(max / 2))).status, 200);
  assert.equal((await send("é".repeat(max / 2) + "a")).status, 413);
});

test("a body a guard already read through Hono is still held to the limit, and stays readable after", async () => {
  // A route guard may read one field with c.req.json() before the body is
  // validated (PR #114's guardField does). That read used to leave nothing
  // for a raw-stream reader, and must not let a large body past the limit.
  const app = new Hono<AppEnv>();
  app.post("/guarded", async (c) => {
    await c.req.json().catch(() => undefined);
    return c.text(String((await readBodyText(c, "control")).length));
  });
  app.post("/unguarded", async (c) => {
    const text = await readBodyText(c, "control");
    const again = (await c.req.json()) as { a: string };
    return c.text(`${text.length} ${again.a.length}`);
  });
  app.onError(handleError);
  const env = { ENVIRONMENT: "development" } as Env;
  const body = (size: number) => JSON.stringify({ a: "x".repeat(size) });

  const guarded = await app.fetch(request("/guarded", body(10), "streamed"), env);
  assert.equal(guarded.status, 200);
  assert.equal(await guarded.text(), String(body(10).length));
  assert.equal((await app.fetch(request("/guarded", body(BODY_LIMITS.control), "streamed"), env)).status, 413);

  const unguarded = await app.fetch(request("/unguarded", body(10), "streamed"), env);
  assert.equal(await unguarded.text(), `${body(10).length} 10`);
});

/* ── Unknown fields ────────────────────────────────────────────────────── */

test("a report with a field the portal does not declare is refused by name and not stored", async (t) => {
  const { send, count } = await world(t);
  const cases: Array<[string, (report: Record<string, unknown>) => void]> = [
    ["notes", (report) => { report.notes = "kept nowhere"; }],
    ["metrics[0].stderr", (report) => { (report.metrics as Array<Record<string, unknown>>)[0]!.stderr = "x"; }],
    ["weightsUploaded[0].mtime", (report) => { (report.weightsUploaded as Array<Record<string, unknown>>)[0]!.mtime = 1; }],
  ];
  for (const [field, add] of cases) {
    const report = structuredClone(reportSync(wires[0]!));
    add(report);
    const response = await send(request("/api/v1/local-reports", JSON.stringify(report)));
    assert.equal(response.status, 400, field);
    assert.deepEqual(await errorOf(response), {
      code: "invalid_request",
      message: `The request body has a field this endpoint does not accept: ${field}.`,
    });
  }
  assert.equal(count("local_reports"), 0);
});

test("a live-run event with an undeclared field is refused by name and records nothing", async (t) => {
  const { send, count } = await world(t);
  const wire = wires[0]!;
  const start = wireRequest(wire, (path) => path === "/api/v1/local-runs");
  assert.equal((await send(request(start.path, JSON.stringify(start.body)))).status, 201);
  const before = count("run_stream_events");

  const single = structuredClone(wireRequest(wire, (path) => path.startsWith(`${start.path}/`) && path.endsWith("/events")));
  (single.body as Record<string, unknown>).cpu = 0.5;
  const one = await send(request(single.path, JSON.stringify(single.body)));
  assert.equal(one.status, 400);
  assert.equal((await errorOf(one)).message, "The request body has a field this endpoint does not accept: cpu.");

  const batch = structuredClone(wireRequest(wire, (path) => path.endsWith("/events/batch")));
  const events = (batch.body as { events: Array<Record<string, unknown>> }).events;
  (events.at(-1)!.report as Record<string, unknown>).hostname = "laptop";
  const many = await send(request(batch.path, JSON.stringify(batch.body)));
  assert.equal(many.status, 400);
  assert.equal(
    (await errorOf(many)).message,
    `The request body has a field this endpoint does not accept: events[${events.length - 1}].report.hostname.`,
  );

  assert.equal(count("run_stream_events"), before);
  assert.equal(count("local_reports"), 0);
});

test("a refused caller still gets the refusal, not a 400 or 413 about its body", async (t) => {
  const { send } = await world(t);
  const report = structuredClone(reportSync(wires[0]!));
  report.notes = "unknown";
  const unknown = await send(request("/api/v1/local-reports", JSON.stringify(report), "content-length", "cog_wrong"));
  assert.equal(unknown.status, 401);
  (report.metrics as Array<Record<string, unknown>>)[0]!.help = "x".repeat(BODY_LIMITS.report);
  const large = await send(request("/api/v1/local-reports", JSON.stringify(report), "streamed", "cog_wrong"));
  assert.equal(large.status, 401);
});

/* ── The SPA's real requests still pass ────────────────────────────────── */

/** The schema each SPA route reads its body with (worker/routes). */
const SPA_ROUTES: Record<string, z.ZodType> = {
  "POST /api/dev/login": DevLoginRequestSchema,
  "POST /api/cohorts/join": JoinCohortRequestSchema,
  // github.ts wraps this to read a blank teamName as absent.
  "POST /api/github/connect": ConnectRepoRequestSchema,
  "POST /api/v1/connections/discord/preview": ConfirmDiscordLinkRequestSchema,
  "POST /api/v1/connections/discord/confirm": ConfirmDiscordLinkRequestSchema,
  "POST /api/v1/cli/device/approve": ApproveDeviceRequestSchema,
  "DELETE /api/v1/cli/devices": RevokeDeviceRequestSchema,
  "PATCH /api/team": UpdateTeamRequestSchema,
  "POST /api/team/repository": ChangeTeamRepoRequestSchema,
  "POST /api/team/join": JoinTeamRequestSchema,
  "POST /api/team/members": AddTeamMemberRequestSchema,
  "POST /api/team/leave": LeaveTeamRequestSchema,
  "PATCH /api/admin/cohort": AdminCohortPatchSchema,
  "PATCH /api/admin/teams/team_1": UpdateTeamRequestSchema,
  "POST /api/admin/teams/team_1/members": AdminAddMemberRequestSchema,
  "POST /api/admin/teams/team_1/tas": AdminAssignTaRequestSchema,
  "POST /api/admin/staff": AdminAddStaffRequestSchema,
  "POST /api/runs/practice": StartPracticeRequestSchema,
  "POST /api/run-surfaces/surface_1/actions/retry": RetryRunRequestSchema,
  "PUT /api/leaderboard-selection": SelectResultRequestSchema,
};

test("every body the SPA's API client sends passes its route's strict schema", async (t) => {
  const sent: Array<{ route: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") sent.push({ route: `${init.method} ${String(input)}`, body: init.body });
    return new Response(JSON.stringify({ error: { code: "not_found", message: "recorded" } }), { status: 404 });
  });
  // Each mutation the SPA has, with arguments shaped like its call sites'.
  const calls = [
    () => api.devLogin({ login: "ada" }),
    () => api.devLogin({ login: "demo", demo: true }),
    () => api.joinCohort("JOINCODE1"),
    () => api.connectRepo({ fullName: "cogworks-demo/face-finder", teamName: "Engines" }),
    () => api.connectRepo({ fullName: "cogworks-demo/face-finder", teamName: undefined }),
    () => api.previewDiscordLink("t".repeat(32)),
    () => api.confirmDiscordLink("t".repeat(32)),
    () => api.approveDevice("ABCD-EFGH-JKLM", "laptop"),
    () => api.revokeDevice("device_1"),
    () => api.updateTeam("team_1", { name: "Engines" }),
    () => api.updateTeam("team_1", { description: null }),
    () => api.changeTeamRepo("team_1", "cogworks-demo/face-finder"),
    () => api.joinTeam("team_1"),
    () => api.addTeamMember("team_1", "grace"),
    () => api.leaveTeam("team_1"),
    () => api.adminPatchCohort({ active: false }),
    () => api.adminPatchCohort({ rotateJoinCode: true }),
    () => api.adminPatchTeam("team_1", { name: "Engines", description: "Search" }),
    () => api.adminAddMember("team_1", "grace"),
    () => api.adminAssignTa("team_1", "grace"),
    () => api.adminAddStaff("grace"),
    () => api.startPractice("team_1", "vision-recognition", "main"),
    () => api.startPractice("team_1", "vision-recognition"),
    () => api.mutateRunSurface("surface_1", "retry", { runId: "run_1" }),
    () => api.selectResult("run_1"),
  ];
  for (const call of calls) await call().catch(() => undefined);

  assert.equal(sent.length, calls.length, "a call sent no body");
  for (const { route, body } of sent) {
    const schema = SPA_ROUTES[route];
    assert.ok(schema, `${route} sends a body and has no schema listed here`);
    const parsed = schema.safeParse(JSON.parse(body));
    assert.ok(parsed.success, `${route} ${body}: ${parsed.error?.message}`);
  }
});
