import { and, eq, isNull, sql } from "drizzle-orm";
import { ZodError } from "zod";
import {
  RUNNER_PROTOCOL_VERSION,
  RunJobV1Schema,
  type RunJobV1,
  type WeightFile,
} from "@cogworks/contracts/protocol";
import type { Env } from "../env";
import { getDb } from "../db/client";
import type { BenchmarkRow, RunRow, TeamRow } from "../db/schema";
import { runs } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { newId } from "../util/id";
import { getLatestTeamWeights } from "../services/local-reports";
import { weightManifest, weightObjectKey } from "../services/weights";
import { preparedEnvironmentMatchesRun, savedEnvironmentEligibility } from "../services/run-eligibility";

const DEFAULT_IMAGE_DIGEST = "cogworks-week2-cpu-v1:unpublished";

function origin(env: Env): string {
  if (!env.PUBLIC_ORIGIN?.startsWith("https://")) {
    throw new ApiHttpError(
      501,
      "provider_unconfigured",
      "PUBLIC_ORIGIN must be configured with the portal HTTPS origin.",
    );
  }
  return env.PUBLIC_ORIGIN.replace(/\/$/, "");
}

/**
 * What Modal dispatch needs: a runner URL, a signing secret, and an origin
 * for the callback. Deliberately not the queue.
 *
 * `dispatchToModal` is one signed HTTPS POST. The queue buys retry and
 * backpressure, which matter under load and not at all for correctness, and
 * Cloudflare Queues is a paid binding that `wrangler dev` cannot provide. So
 * requiring it here made the real execution path untestable locally and gated
 * the whole platform on a billing decision rather than on working code.
 *
 * With a queue bound, runs go through it. Without one, `dispatch` posts
 * directly and records the same events; see `enqueueRun`.
 */
export function assertModalConfigured(env: Env): asserts env is Env & {
  MODAL_RUNNER_URL: string;
  RUNNER_SIGNING_SECRET: string;
} {
  if (!env.MODAL_RUNNER_URL || !env.RUNNER_SIGNING_SECRET) {
    throw new ApiHttpError(
      501,
      "provider_unconfigured",
      "Modal dispatch needs MODAL_RUNNER_URL and RUNNER_SIGNING_SECRET.",
    );
  }
  origin(env);
}

const RunJobInputsSchema = RunJobV1Schema.omit({ jobId: true, callback: true });

// Render-time Retry checks need the same execution inputs without minting a
// transport ID or requiring callback/provider configuration.
function buildRunJobInputs(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
  weights: WeightFile[] = [],
): Omit<RunJobV1, "jobId" | "callback"> {
  const fullName = `${encodeURIComponent(team.repoOwner)}/${encodeURIComponent(team.repoName)}`;
  if (benchmark.sandboxContract == null || !Number.isSafeInteger(benchmark.sandboxContract) || benchmark.sandboxContract <= 0) {
    throw new ApiHttpError(409, "not_promotable", "The benchmark's execution contract is unknown.");
  }
  let preparedEnvironment = null;
  if (run.preparedArtifactId || run.preparedEnvironmentJson) {
    const eligibility = savedEnvironmentEligibility(run, benchmark, team);
    if (!eligibility.eligible) throw new ApiHttpError(409, "not_promotable", eligibility.reason);
    preparedEnvironment = eligibility.environment;
  }
  return RunJobInputsSchema.parse({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runId: run.id,
    mode: run.mode,
    preparedArtifactId: run.preparedArtifactId,
    preparedEnvironment,
    source: {
      repositoryId: run.repositoryId,
      fullName: team.repoFullName,
      sha: run.sha,
      archiveUrl: `https://api.github.com/repos/${fullName}/tarball/${run.sha}`,
    },
    benchmark: {
      id: benchmark.id,
      version: benchmark.version,
      contractVersion: benchmark.contractVersion,
      pluginVersion: benchmark.pluginVersion,
      datasetVersion: run.mode === "official" ? benchmark.datasetVersion : "practice-v1",
      scorerVersion: benchmark.scorerVersion,
      sandboxContract: benchmark.sandboxContract,
    },
    runtime: {
      // What the student's code actually runs on, which is not one number
      // any more: the shared image is 3.11 (Modal's builder dropped 3.8), but
      // week1 and week3 exec every prepare/evaluate step through the pinned
      // CPython 3.8.20 venv baked into their images. See
      // modal_app._student_python. This value is recorded on the run, so a
      // wrong default is a wrong record, not a cosmetic default.
      pythonVersion:
        benchmark.id === "language-search" || benchmark.id === "audio-identification"
          ? "3.8"
          : (env.RUNNER_PYTHON_VERSION ?? "3.11"),
      imageDigest: env.RUNNER_IMAGE_DIGEST ?? DEFAULT_IMAGE_DIGEST,
      cpu: 1,
      // Week 3 evaluation loads the 200-d GloVe table inside the sandbox
      // (~350 MB warm via the .kv cache, ~1.5 GB peak on a cold text parse),
      // so its ceiling is double the vision default.
      //
      // Week 1 renders its 30-song catalog of float32 audio in memory before
      // any student code runs, and the submission usually keeps a second copy
      // as fingerprints. Memory measured with `/usr/bin/time -l` on a laptop
      // over the evaluation tier (30 songs, 252 queries) under Python 3.8.20:
      //
      //   tuned reference (examples/week1-audio-submission)   1.52 GB
      //   KrazeeCoder/week1-capstone-team4                    1.01 GB
      //   carti4ce/week1_capstone                             1.42 GB
      //
      // 4 GB is double the worst measured peak.
      //
      // Wall clock is measured on Modal itself, because the laptop numbers
      // were badly optimistic. End-to-end for one hosted run, evaluate phase:
      //
      //   KrazeeCoder/week1-capstone-team4    75 s, 72 s  (laptop said 16 s)
      //   carti4ce/week1_capstone            875 s, 898 s  (laptop said 381 s)
      //
      // Two hosted runs each, weeks apart. So carti4ce clears 900 s by 2.8%
      // and then by 0.2%, not by the 2.4x an earlier note here claimed from
      // laptop timings. That margin is a coin flip, and the same submission
      // timed out at 999 s on a third run. It is slow
      // for a structural reason -- its database.add reloads and rewrites the
      // whole pickle per song and query_details reloads it per query, so cost
      // grows with the catalog rather than with the clip.
      //
      // Deliberately not raising the number. A budget wide enough for an
      // O(N^2) database is a budget that no longer means anything, and the
      // failure is now legible: `_timed_out` reports it as a timeout naming
      // the budget and that shape of database, rather than as "Evaluation
      // failed." The real fix, when a team hits it, is a per-case budget in
      // the driver so a slow enroll is attributed to the song it stalled on.
      memoryMb:
        benchmark.id === "language-search" || benchmark.id === "audio-identification"
          ? 4_096
          : 2_048,
      timeoutSeconds: 900,
      maxOutputBytes: 8 * 1_024,
    },
    ...(run.preparedArtifactId ? {} : { weights }),
  });
}

function callbackFor(env: Env): RunJobV1["callback"] {
  return {
    url: `${origin(env)}/api/internal/v1/runner/events`,
    keyId: env.RUNNER_SIGNING_KEY_ID ?? "runner-v1",
  };
}

export function buildRunJob(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
  weights: WeightFile[] = [],
): RunJobV1 {
  return RunJobV1Schema.parse({
    ...buildRunJobInputs(env, run, team, benchmark, weights),
    jobId: newId("job_"), callback: callbackFor(env),
  });
}

function retryInputError(detail: string): ApiHttpError {
  return new ApiHttpError(409, "invalid_request", detail);
}

function recordedJob(run: RunRow): RunJobV1 {
  if (!run.dispatchJobJson) {
    throw retryInputError("This run has no recorded dispatch inputs. Start a new candidate.");
  }
  let job: RunJobV1;
  try {
    job = RunJobV1Schema.parse(JSON.parse(run.dispatchJobJson));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof ZodError)) throw error;
    throw retryInputError("This run's recorded dispatch inputs are invalid. Start a new candidate.");
  }
  if (job.runId !== run.id || job.mode !== run.mode || job.source.sha !== run.sha ||
      job.source.repositoryId !== run.repositoryId || job.benchmark.id !== run.benchmarkId ||
      job.benchmark.version !== run.benchmarkVersion ||
      job.benchmark.contractVersion !== run.contractVersion ||
      job.benchmark.datasetVersion !== run.datasetVersion ||
      job.benchmark.scorerVersion !== run.scorerVersion ||
      job.protocolVersion !== run.protocolVersion || run.provider !== "modal") {
    throw retryInputError("Recorded dispatch inputs do not match this run.");
  }
  if ((job.mode === "official" && !job.preparedArtifactId) ||
      (!job.preparedArtifactId && !job.weights) ||
      (job.preparedArtifactId && job.weights !== undefined)) {
    throw retryInputError("Recorded dispatch artifact or weight inputs are inconsistent.");
  }
  if (job.preparedArtifactId) {
    if (!job.preparedEnvironment || !preparedEnvironmentMatchesRun(job.preparedEnvironment, {
      ...run, preparedArtifactId: job.preparedArtifactId,
    }, job.source.fullName)) {
      throw retryInputError("The recorded saved environment has no matching provisioning evidence.");
    }
  } else if (job.preparedEnvironment) {
    throw retryInputError("Recorded provisioning evidence has no saved artifact.");
  }
  return job;
}

async function validateRecordedWeights(env: Env, job: RunJobV1): Promise<void> {
  const weights = job.weights ?? [];
  if (!weights.length) return;
  if (!env.ARTIFACTS) throw retryInputError("Recorded weight storage is unavailable.");
  const seen = new Set<string>();
  for (const weight of weights) {
    if (seen.has(weight.path)) throw retryInputError("Recorded weight paths contain duplicates.");
    seen.add(weight.path);
    let key: string;
    try {
      key = weightObjectKey(job.source.fullName, job.source.sha, weight.path);
    } catch {
      throw retryInputError("A recorded weight path is invalid.");
    }
    const object = await env.ARTIFACTS.head(key);
    if (!object) throw retryInputError(`Recorded weight ${weight.path} is unavailable.`);
    const checksum = object.checksums.sha256;
    const digest = checksum && [...new Uint8Array(checksum)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (object.size !== weight.size || digest !== weight.sha256) {
      throw retryInputError(`Recorded weight ${weight.path} has changed or has no matching checksum.`);
    }
  }
}

/** Read-only validation shared by admission and Retry advertisement. It returns
 * the original dispatch inputs and performs no transport or availability work. */
export function validateRetryInputs(
  env: Env,
  failedRun: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
): RunJobV1 {
  const saved = recordedJob(failedRun);
  if (failedRun.status !== "failed" || failedRun.teamId !== team.id ||
      failedRun.repositoryId !== team.repoId ||
      env.EXECUTION_PROVIDER !== failedRun.provider ||
      failedRun.runtimeVersion !== benchmark.runtimeVersion) {
    throw retryInputError("Retry status, team, repository, provider, or runtime version does not match.");
  }
  // The row may carry an artifact from a late completion. Only the dispatch
  // record identifies whether the original execution prepared its own inputs.
  let current: Omit<RunJobV1, "jobId" | "callback">;
  try {
    current = buildRunJobInputs(env, {
      ...failedRun, preparedArtifactId: saved.preparedArtifactId,
      preparedEnvironmentJson: saved.preparedEnvironment ? JSON.stringify(saved.preparedEnvironment) : null,
    }, team, benchmark, saved.weights);
  } catch (error) {
    if (!(error instanceof ZodError) && !(error instanceof ApiHttpError && error.status === 409)) throw error;
    throw retryInputError("Current repository or benchmark/runtime configuration is invalid for retry.");
  }
  if (JSON.stringify(saved.source) !== JSON.stringify(current.source) ||
      JSON.stringify(saved.benchmark) !== JSON.stringify(current.benchmark) ||
      JSON.stringify(saved.runtime) !== JSON.stringify(current.runtime) ||
      saved.protocolVersion !== current.protocolVersion) {
    throw retryInputError("Repository or benchmark/runtime configuration changed since this run.");
  }
  return saved;
}

/** Availability and transport checks stay at admission. A missing snapshot is
 * still the provider's terminal failure, never a render-time preflight. */
export async function prepareRetryJob(
  env: Env,
  failedRun: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
  newRunId: string,
): Promise<RunJobV1> {
  const saved = validateRetryInputs(env, failedRun, team, benchmark);
  assertModalConfigured(env);
  await validateRecordedWeights(env, saved);
  if (!newRunId || newRunId === failedRun.id) {
    throw retryInputError("Retry requires a new execution ID.");
  }
  return RunJobV1Schema.parse({
    ...saved, jobId: newId("job_"), runId: newRunId, callback: callbackFor(env),
  });
}

/**
 * Hand one run to Modal, through the queue when there is one.
 *
 * The queue gives retry with backoff and a dead-letter path, so it stays the
 * production shape. Without it -- `wrangler dev`, or a deployment before
 * Queues is enabled on the account -- this posts directly instead of
 * refusing. The direct path has no retry: definite rejections fail the run
 * immediately; unknown acceptance waits for a callback or the stale-run reaper.
 */
export async function enqueueRun(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
): Promise<void> {
  assertModalConfigured(env);
  const db = getDb(env);
  const [stored] = await db.select().from(runs).where(eq(runs.id, run.id)).limit(1);
  if (!stored) throw retryInputError("The execution to dispatch does not exist.");
  if (stored.provider !== env.EXECUTION_PROVIDER || stored.teamId !== team.id) {
    throw retryInputError("Dispatch provider or team does not match the recorded execution.");
  }
  if (stored.dispatchJobJson === null) {
    let weights: WeightFile[] = [];
    if (!stored.preparedArtifactId) {
      const report = await getLatestTeamWeights(env, stored.teamId, team.repoFullName, stored.sha);
      weights = await weightManifest(
        env.ARTIFACTS, team.repoFullName, stored.sha, report.weightsUsed, report.weightsUploaded,
      );
    }
    const candidate = buildRunJob(env, stored, team, benchmark, weights);
    const dispatchJobJson = JSON.stringify(candidate);
    recordedJob({ ...stored, dispatchJobJson });
    // Concurrent dispatchers may prepare different jobs. The first persisted
    // inputs win; every sender reloads that record rather than sending its own.
    await db.update(runs).set({ dispatchJobJson })
      .where(and(eq(runs.id, stored.id), isNull(runs.dispatchJobJson)));
  }
  const [recorded] = await db.select().from(runs).where(eq(runs.id, run.id)).limit(1);
  if (!recorded) throw retryInputError("The execution to dispatch no longer exists.");
  const job = recordedJob(recorded);
  await validateRecordedWeights(env, job);
  if (env.RUN_QUEUE) {
    await env.RUN_QUEUE.send(job, { contentType: "json" });
    return;
  }
  await dispatchToModal(env, job);
}

export async function hmacSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The provider did not acknowledge acceptance or refusal of the job.
 *
 * `submit_job` spawns the run before it replies (see the Modal runner), so a
 * request that times out or fails in transit may well have started a run.
 * An infrastructure response can also hide that acknowledgement.
 */
export class DispatchUnacknowledged extends Error {
  constructor(cause: unknown) {
    super("The Modal runner did not answer the dispatch request.");
    this.name = "DispatchUnacknowledged";
    this.cause = cause;
  }
}

async function dispatchToModal(env: Env, job: RunJobV1): Promise<void> {
  assertModalConfigured(env);
  const body = JSON.stringify(job);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await hmacSignature(env.RUNNER_SIGNING_SECRET, timestamp, body);
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(env.MODAL_RUNNER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogworks-Timestamp": timestamp,
        "X-Cogworks-Key-Id": env.RUNNER_SIGNING_KEY_ID ?? "runner-v1",
        "X-Cogworks-Signature": `v1=${signature}`,
      },
      body,
      signal,
    });
  } catch (error) {
    throw new DispatchUnacknowledged(error);
  }
  // modal_app.py submit_job returns 400/401 before spawning, then 202.
  // A 4xx is refusal; other unexpected statuses may come from a gateway
  // that lost the 202 after the job started, so acceptance is unknown.
  if (response.status >= 400 && response.status < 500) {
    throw new Error(`Modal runner rejected job with status ${response.status}.`);
  }
  if (response.status !== 202) {
    throw new DispatchUnacknowledged(
      new Error(`Modal dispatch returned unexpected status ${response.status}.`),
    );
  }
  // Modal holds the job from here on. The attempt counter is bookkeeping; a
  // failed write must not read as a failed dispatch, or the caller would
  // release an official-attempt claim for a run that is actually executing.
  try {
    await getDb(env)
      .update(runs)
      .set({ dispatchAttempts: sql`${runs.dispatchAttempts} + 1` })
      .where(eq(runs.id, job.runId));
  } catch {
    // Accepted; the counter is off by one and nothing else is wrong.
  }
}

export async function handleRunQueue(batch: MessageBatch<RunJobV1>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const job = RunJobV1Schema.parse(message.body);
      await dispatchToModal(env, job);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "modal_dispatch_failed",
          messageId: message.id,
          detail: error instanceof Error ? error.message : "unknown",
        }),
      );
      message.retry({ delaySeconds: 30 });
    }
  }
}
