import { eq, sql } from "drizzle-orm";
import {
  RUNNER_PROTOCOL_VERSION,
  RunJobV1Schema,
  type RunJobV1,
} from "@cogworks/contracts/protocol";
import type { Env } from "../env";
import { getDb } from "../db/client";
import type { BenchmarkRow, RunRow, TeamRow } from "../db/schema";
import { runs } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { newId } from "../util/id";

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

export function assertModalConfigured(env: Env): asserts env is Env & {
  RUN_QUEUE: NonNullable<Env["RUN_QUEUE"]>;
  MODAL_RUNNER_URL: string;
  RUNNER_SIGNING_SECRET: string;
} {
  if (!env.RUN_QUEUE || !env.MODAL_RUNNER_URL || !env.RUNNER_SIGNING_SECRET) {
    throw new ApiHttpError(
      501,
      "provider_unconfigured",
      "Modal dispatch is not configured. Keep fixture execution enabled until M0 passes.",
    );
  }
  origin(env);
}

export function buildRunJob(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
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
      // week3 execs every prepare/evaluate step through the pinned CPython
      // 3.8.20 venv baked into that image. See modal_app._student_python.
      // This value is recorded on the run, so a wrong default is a wrong
      // record, not a cosmetic default.
      pythonVersion:
        benchmark.id === "language-search"
          ? "3.8"
          : (env.RUNNER_PYTHON_VERSION ?? "3.11"),
      imageDigest: env.RUNNER_IMAGE_DIGEST ?? DEFAULT_IMAGE_DIGEST,
      cpu: 1,
      // Week 3 evaluation loads the 200-d GloVe table inside the sandbox
      // (~350 MB warm via the .kv cache, ~1.5 GB peak on a cold text parse),
      // so its ceiling is double the vision default.
      memoryMb: benchmark.id === "language-search" ? 4_096 : 2_048,
      timeoutSeconds: 900,
      maxOutputBytes: 8 * 1_024,
    },
    callback: {
      url: `${origin(env)}/api/internal/v1/runner/events`,
      keyId: env.RUNNER_SIGNING_KEY_ID ?? "runner-v1",
    },
  });
}

export async function enqueueRun(
  env: Env,
  run: RunRow,
  team: TeamRow,
  benchmark: BenchmarkRow,
): Promise<void> {
  assertModalConfigured(env);
  await env.RUN_QUEUE.send(buildRunJob(env, run, team, benchmark), { contentType: "json" });
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
  await getDb(env)
    .update(runs)
    .set({ dispatchAttempts: sql`${runs.dispatchAttempts} + 1` })
    .where(eq(runs.id, job.runId));
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
