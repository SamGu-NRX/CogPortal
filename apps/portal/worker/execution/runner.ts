import { eq, sql } from "drizzle-orm";
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
import { getLatestTeamWeightPaths } from "../services/local-reports";
import { weightManifest } from "../services/weights";

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

export function buildRunJob(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
  weights: WeightFile[] = [],
): RunJobV1 {
  const fullName = `${encodeURIComponent(team.repoOwner)}/${encodeURIComponent(team.repoName)}`;
  return RunJobV1Schema.parse({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    jobId: newId("job_"),
    runId: run.id,
    mode: run.mode,
    preparedArtifactId: run.preparedArtifactId,
    source: {
      repositoryId: team.repoId,
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
    callback: {
      url: `${origin(env)}/api/internal/v1/runner/events`,
      keyId: env.RUNNER_SIGNING_KEY_ID ?? "runner-v1",
    },
    ...(run.preparedArtifactId ? {} : { weights }),
  });
}

/**
 * Hand one run to Modal, through the queue when there is one.
 *
 * The queue gives retry with backoff and a dead-letter path, so it stays the
 * production shape. Without it -- `wrangler dev`, or a deployment before
 * Queues is enabled on the account -- this posts directly instead of
 * refusing. The direct path has no retry: a failed dispatch surfaces
 * immediately as a failed run rather than being retried for thirty seconds,
 * which is the honest trade for being able to run the real path at all.
 */
export async function enqueueRun(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
): Promise<void> {
  assertModalConfigured(env);
  let weights: WeightFile[] = [];
  if (env.ARTIFACTS && !run.preparedArtifactId) {
    const paths = await getLatestTeamWeightPaths(env, run.teamId, team.repoFullName, run.sha);
    weights = await weightManifest(env.ARTIFACTS, team.repoFullName, run.sha, paths);
  }
  const job = buildRunJob(env, run, team, benchmark, weights);
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

async function dispatchToModal(env: Env, job: RunJobV1): Promise<void> {
  assertModalConfigured(env);
  const body = JSON.stringify(job);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const response = await fetch(env.MODAL_RUNNER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cogworks-Timestamp": timestamp,
      "X-Cogworks-Key-Id": env.RUNNER_SIGNING_KEY_ID ?? "runner-v1",
      "X-Cogworks-Signature": `v1=${await hmacSignature(env.RUNNER_SIGNING_SECRET, timestamp, body)}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 202) {
    throw new Error(`Modal runner rejected job with status ${response.status}.`);
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
