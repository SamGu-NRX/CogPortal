import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import type { RunJobV1 } from "@cogworks/contracts/protocol";
import { benchmarks, cohorts, runs, teams, type BenchmarkRow, type RunRow, type TeamRow } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";

/**
 * The runner fetches a team's trained weights from this route while a run is
 * preparing, with a URL signed before preparation started. Nothing else in the
 * suite drives it, and the two ways it can be wrong are both silent: it can
 * serve bytes belonging to whatever repository the team is connected to *now*,
 * and it can serve bytes that are no longer the ones the run recorded.
 *
 * These tests go through the real Worker, so the mount prefix, Hono's wildcard
 * decoding, and the signature window are exercised rather than assumed.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkerEntrypoint{};export class DurableObject{};",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { default: worker } = await import("../worker/index.ts");
const { buildRunJob, hmacSignature } = await import("../worker/execution/runner.ts");

const SECRET = "runner-download-secret";
const ORIGIN = "https://portal.example.com";
const SHA = "a".repeat(40);
const DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // "abc"
const OTHER_DIGEST = "c".repeat(64);

const dispatchTeam: TeamRow = {
  id: "team_download", cohortId: "cohort_download", name: "Download team", description: null,
  repoOwner: "course", repoName: "original", repoFullName: "course/original", repoId: 42,
  repoUrl: "https://github.com/course/original", defaultBranch: "main",
  templateSourceRepoId: null, discordChannelId: null, provenance: "live",
};
const benchmark: BenchmarkRow = {
  id: "vision-recognition", version: 1, contractVersion: "cogworks.submissions.v1",
  pluginVersion: "1", datasetVersion: "official-v1", scorerVersion: "1", runtimeVersion: "python-3.11",
  entryPointName: "submission", title: "Vision", module: "vision", summary: "Download test",
  active: true, primaryMetricKey: "accuracy", sandboxContract: 1,
};

function runRow(): RunRow {
  return {
    id: "run_download", teamId: dispatchTeam.id, benchmarkId: benchmark.id, benchmarkVersion: 1,
    contractVersion: benchmark.contractVersion, mode: "practice", status: "preparing", branch: "main",
    sha: SHA, repositoryId: dispatchTeam.repoId, provider: "modal", protocolVersion: "1",
    datasetVersion: "practice-v1", scorerVersion: benchmark.scorerVersion,
    runtimeVersion: benchmark.runtimeVersion, preparedArtifactId: null, preparedEnvironmentJson: null,
    createdAt: 1, finishedAt: null, lastEventSequence: -1, dispatchAttempts: 0,
    parentRunId: null, retryOfRunId: null, dispatchJobJson: null, attemptNumber: null,
    failureCategory: null, failurePhase: null, failureDetail: null, failureConsumedAttempt: false,
    refundedAt: null, log: null, diagnosticsJson: null, wiringJson: null, refusalJson: null,
    sweepJson: null, weightsSuppliedJson: "[]", environmentDigest: null, surfaceId: null,
  };
}

function dispatchedJob(weights: NonNullable<RunJobV1["weights"]>): RunJobV1 {
  const env: Env = {
    ENVIRONMENT: "development", DEV_AUTH: "disabled", PUBLIC_ORIGIN: ORIGIN,
    EXECUTION_PROVIDER: "modal", RUNNER_IMAGE_DIGEST: "im-test",
    get DB(): Env["DB"] { throw new Error("Job construction must not access D1"); },
    get ASSETS(): Env["ASSETS"] { throw new Error("Job construction must not access assets"); },
    get RUN_SURFACES(): Env["RUN_SURFACES"] { throw new Error("Job construction must not access consoles"); },
  };
  return buildRunJob(env, runRow(), dispatchTeam, benchmark, weights);
}

function hexBytes(digest: string): ArrayBuffer {
  const bytes = digest.match(/../g);
  assert.ok(bytes, "digest must contain hexadecimal bytes");
  return Uint8Array.from(bytes.map((byte) => parseInt(byte, 16))).buffer;
}

/** Just enough of an R2 body for this route: size, checksum, metadata, bytes. */
function storedObject(body: string, digest: string | null, size = body.length) {
  return {
    size,
    checksums: digest == null ? {} : { sha256: hexBytes(digest) },
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "application/octet-stream"),
    body: new Blob([body]).stream(),
  };
}

async function harness(options: {
  job?: RunJobV1 | string | null;
  objects?: Record<string, ReturnType<typeof storedObject>>;
  currentRepoFullName?: string;
} = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql"))
    .sort().filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  // SAFETY: drizzle's d1 driver uses only prepare/bind/run/all/raw here.
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let values: SQLInputValue[] = [];
      const prepared = {
        bind(...params: SQLInputValue[]) { values = params; return prepared; },
        async run() { return { success: true, meta: statement.run(...values) }; },
        async all() { return { success: true, results: statement.all(...values) }; },
        async raw() {
          statement.setReturnArrays(true);
          const rows = statement.all(...values);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  } as unknown as Env["DB"];
  const db = drizzle(binding);
  await db.insert(cohorts).values({ id: "cohort_download", slug: "dl", name: "Download", joinCode: "DLCODE", active: true });
  await db.insert(teams).values({
    ...dispatchTeam,
    // A rename or a reconnect changes this row. The recorded job does not move.
    repoFullName: options.currentRepoFullName ?? dispatchTeam.repoFullName,
  });
  await db.insert(benchmarks).values(benchmark);
  const job = options.job === undefined ? dispatchedJob([{ path: "model.pkl", size: 3, sha256: DIGEST }]) : options.job;
  await db.insert(runs).values({
    ...runRow(),
    dispatchJobJson: job == null ? null : (typeof job === "string" ? job : JSON.stringify(job)),
  });

  const reads: string[] = [];
  const objects = new Map(Object.entries(options.objects ?? {}));
  // SAFETY: this route uses D1, R2 and signing configuration only. The fixture
  // omits unrelated bindings; getters cannot guard them because env validation reads every property.
  const env = {
    ENVIRONMENT: "development", DEV_AUTH: "disabled", EXECUTION_PROVIDER: "modal",
    PUBLIC_ORIGIN: ORIGIN, RUNNER_SIGNING_SECRET: SECRET, DB: binding,
    // SAFETY: this route calls only get and reads size, checksum, metadata and body.
    // The fixture does not implement other R2 operations or object properties.
    ARTIFACTS: {
      get: async (key: string) => {
        reads.push(key);
        return objects.get(key) ?? null;
      },
    } as NonNullable<Env["ARTIFACTS"]>,
    ASSETS: { fetch: () => { throw new Error("the weight route fell through to static assets"); } },
  } as Env;
  return { env, reads, sqlite };
}

function downloadContext(): ExecutionContext {
  // SAFETY: downloads finish within the request and need no host context methods.
  return {} as ExecutionContext;
}

function fetchWeight(env: Env, path: string, runId = "run_download"): Promise<Response> {
  // Same encoding the Modal runner applies: quote(path, safe="/").
  return fetchSignedPath(env, path.split("/").map(encodeURIComponent).join("/"), runId);
}

async function fetchSignedPath(env: Env, encoded: string, runId = "run_download"): Promise<Response> {
  const pathname = `/api/v1/runs/${runId}/weights/${encoded}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return worker.fetch(
    new Request(ORIGIN + pathname, {
      headers: {
        "X-Cogworks-Key-Id": "runner-v1",
        "X-Cogworks-Timestamp": timestamp,
        "X-Cogworks-Signature": `v1=${await hmacSignature(SECRET, timestamp, pathname)}`,
      },
    }),
    env,
    downloadContext(),
  );
}

async function failure(response: Response): Promise<{ status: number; message: string | undefined }> {
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  return { status: response.status, message: body.error?.message };
}

test("a signed weight URL serves the bytes the dispatched run recorded", async () => {
  const key = `weight-objects/course/original/${SHA}/${DIGEST}/model.pkl`;
  const { env, reads, sqlite } = await harness({
    objects: { [key]: storedObject("abc", DIGEST) },
    // The team reconnected to a different repository after dispatch. A URL
    // signed for this run must not follow that move.
    currentRepoFullName: "course/renamed",
  });
  try {
    const response = await fetchWeight(env, "model.pkl");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), "3");
    assert.equal(await response.text(), "abc");
    assert.deepEqual(reads, [key]);
    assert.equal(reads.some((read) => read.includes("renamed")), false);
  } finally { sqlite.close(); }
});

test("a percent-encoded path reaches the exact manifest entry it names", async () => {
  // Hono's own `c.req.path` decodes with `decodeURI`, which resolves `%20` but
  // leaves `%23` and `%3F` encoded, so a name containing any of these would not
  // match the entry the runner asked for. The characters below are the ones
  // where the two decodings disagree, plus a literal `%2F`, which must stay a
  // character in a file name rather than becoming a separator.
  for (const path of [
    "models/final model.pkl",
    "models/a#b.pkl",
    "models/a?b.pkl",
    "models/100%.pkl",
    "models/a%2Fb.pkl",
    "models/naïve-模型.pkl",
  ]) {
    const key = `weight-objects/course/original/${SHA}/${DIGEST}/${path}`;
    const { env, reads, sqlite } = await harness({
      job: dispatchedJob([{ path, size: 3, sha256: DIGEST }]),
      objects: { [key]: storedObject("abc", DIGEST) },
    });
    try {
      const response = await fetchWeight(env, path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "abc", path);
      assert.deepEqual(reads, [key], path);
    } finally { sqlite.close(); }
  }
});

test("an encoded separator cannot stand in for a path this run did not record", async () => {
  const declared = "models/model.pkl";
  const key = `weight-objects/course/original/${SHA}/${DIGEST}/${declared}`;
  const { env, reads, sqlite } = await harness({
    job: dispatchedJob([{ path: declared, size: 3, sha256: DIGEST }]),
    objects: { [key]: storedObject("abc", DIGEST) },
  });
  try {
    // Each of these decodes to the declared path under a second decode or a
    // naive one, and none of them is the path the runner signed for.
    for (const encoded of ["models%2Fmodel.pkl", "models%2fmodel.pkl", "models/model%00.pkl"]) {
      const response = await failure(await fetchSignedPath(env, encoded));
      assert.equal(response.status, 400, encoded);
      assert.match(response.message ?? "", /stay inside the repository/, encoded);
    }
    assert.deepEqual(reads, []);
  } finally { sqlite.close(); }
});

test("only a path this run recorded is served", async () => {
  const { env, reads, sqlite } = await harness();
  try {
    for (const path of ["other.pkl", "models/model.pkl"]) {
      assert.equal((await fetchWeight(env, path)).status, 404, path);
    }
    // A path that would have to be rewritten to be safe is refused outright,
    // rather than normalized into the one the run did record. Traversal never
    // gets this far: URL parsing collapses `..` and `%2E%2E` alike, which
    // breaks the signature over the path the runner signed.
    for (const path of ["model.pkl/", "models//model.pkl"]) {
      assert.equal((await fetchSignedPath(env, path)).status, 400, path);
    }
    assert.deepEqual(reads, []);
  } finally { sqlite.close(); }
});

test("a prepared run exposes no weight paths at all", async () => {
  const prepared = dispatchedJob([]);
  const { env, reads, sqlite } = await harness({
    job: { ...prepared, weights: undefined, preparedArtifactId: "im-prepared" },
  });
  try {
    // A run that reuses a saved environment carries no manifest, so there is
    // nothing for a signed URL to name.
    assert.equal((await fetchWeight(env, "model.pkl")).status, 409);
    assert.deepEqual(reads, []);
  } finally { sqlite.close(); }
});

test("dispatch inputs that do not belong to this run serve nothing", async () => {
  const weights = [{ path: "model.pkl", size: 3, sha256: DIGEST }];
  const cases: Array<[string, RunJobV1 | string | null]> = [
    ["absent", null],
    ["malformed", "{"],
    ["another run", { ...dispatchedJob(weights), runId: "run_other" }],
    ["another revision", (() => {
      const job = dispatchedJob(weights);
      return { ...job, source: { ...job.source, sha: "b".repeat(40) } };
    })()],
    ["another repository ID", (() => {
      const job = dispatchedJob(weights);
      return { ...job, source: { ...job.source, repositoryId: 43 } };
    })()],
    ["a duplicate path", dispatchedJob([...weights, ...weights])],
  ];
  for (const [name, job] of cases) {
    const { env, reads, sqlite } = await harness({ job });
    try {
      const response = await failure(await fetchWeight(env, "model.pkl"));
      assert.equal(response.status, 409, name);
      assert.deepEqual(reads, [], name);
    } finally { sqlite.close(); }
  }
});

test("the object that would be streamed is the object that is checked", async () => {
  const key = `weight-objects/course/original/${SHA}/${DIGEST}/model.pkl`;
  for (const stored of [
    storedObject("abcd", DIGEST, 4),
    storedObject("abc", OTHER_DIGEST),
    storedObject("abc", null),
  ]) {
    const { env, sqlite } = await harness({ objects: { [key]: stored } });
    try {
      const response = await failure(await fetchWeight(env, "model.pkl"));
      assert.equal(response.status, 409);
      assert.match(response.message ?? "", /not the file this run recorded/);
    } finally { sqlite.close(); }
  }
});

test("a pre-digest object is read only on a miss, and only when it is the recorded file", async () => {
  const digestKey = `weight-objects/course/original/${SHA}/${DIGEST}/model.pkl`;
  const legacyKey = `weights/course/original/${SHA}/model.pkl`;
  const served = await harness({
    objects: { [legacyKey]: storedObject("abc", DIGEST) },
    currentRepoFullName: "course/renamed",
  });
  try {
    const response = await fetchWeight(served.env, "model.pkl");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "abc");
    assert.deepEqual(served.reads, [digestKey, legacyKey]);
  } finally { served.sqlite.close(); }

  // Overwritable storage: a hit there proves nothing without the checksum.
  for (const stale of [storedObject("abc", OTHER_DIGEST), storedObject("abc", null), storedObject("abcd", DIGEST, 4)]) {
    const { env, sqlite } = await harness({ objects: { [legacyKey]: stale } });
    try {
      assert.equal((await fetchWeight(env, "model.pkl")).status, 409);
    } finally { sqlite.close(); }
  }

  // A content-addressed object that fails its checks is refused where it is,
  // never retried against the mutable key.
  const refused = await harness({
    objects: { [digestKey]: storedObject("abc", null), [legacyKey]: storedObject("abc", DIGEST) },
  });
  try {
    assert.equal((await fetchWeight(refused.env, "model.pkl")).status, 409);
    assert.deepEqual(refused.reads, [digestKey]);
  } finally { refused.sqlite.close(); }
});

test("an unsigned or stale request never reaches storage", async () => {
  const key = `weight-objects/course/original/${SHA}/${DIGEST}/model.pkl`;
  const { env, reads, sqlite } = await harness({ objects: { [key]: storedObject("abc", DIGEST) } });
  try {
    const pathname = `/api/v1/runs/run_download/weights/model.pkl`;
    const stale = String(Math.floor(Date.now() / 1_000) - 1_000);
    for (const headers of [
      {},
      { "X-Cogworks-Key-Id": "runner-v1" },
      {
        "X-Cogworks-Key-Id": "runner-v1", "X-Cogworks-Timestamp": stale,
        "X-Cogworks-Signature": `v1=${await hmacSignature(SECRET, stale, pathname)}`,
      },
    ]) {
      const response = await worker.fetch(new Request(ORIGIN + pathname, { headers }), env, downloadContext());
      assert.equal(response.status, 401);
    }
    assert.deepEqual(reads, []);
  } finally { sqlite.close(); }
});
