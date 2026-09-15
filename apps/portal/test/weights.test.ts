import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRunJob, hmacSignature } from "../worker/execution/runner.ts";
import { verifyRunnerSignature } from "../worker/routes/runner-events.ts";
import {
  MAX_WEIGHT_BYTES,
  uploadWeight,
  validateWeightPath,
  weightManifest,
  weightObjectKey,
} from "../worker/services/weights.ts";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function stream(body: string): ReadableStream<Uint8Array> {
  return new Blob([body]).stream();
}

function runParts(mode: "practice" | "official" = "practice") {
  return {
    run: {
      id: "run_1",
      teamId: "team_1",
      mode,
      preparedArtifactId: mode === "official" ? "snapshot_1" : null,
      benchmarkId: "language-search",
      repositoryId: 1,
      preparedEnvironmentJson: mode === "official" ? JSON.stringify({
        schemaVersion: 1, artifactId: "snapshot_1", benchmarkId: "language-search",
        source: { repositoryId: 1, fullName: "course/team", sha: "a".repeat(40) },
        sandboxContract: 1, baseImageId: "im-base", pythonVersion: "3.8.20", sdkVersion: "0.2.0",
        modules: [{ name: "cogbench.execution", path: "/opt/platform/cogbench/execution.py", sha256: SHA256_ABC }], weights: [],
      }) : null,
      sha: "a".repeat(40),
    } as never,
    team: {
      repoOwner: "course",
      repoName: "team",
      repoFullName: "course/team",
      repoId: 1,
    } as never,
    benchmark: {
      id: "language-search",
      version: 1,
      contractVersion: "cogworks.submissions.v2",
      pluginVersion: "1.0.0",
      datasetVersion: "eval-v1",
      scorerVersion: "1.0.0",
      sandboxContract: 1,
    } as never,
  };
}

test("development and production use separate artifact buckets", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const [development, production] = config.split('"env":', 2);

  assert.match(development, /"bucket_name": "cogportal-artifacts-dev"/);
  assert.doesNotMatch(development, /"bucket_name": "cogportal-artifacts"/);
  assert.match(production, /"bucket_name": "cogportal-artifacts"/);
});

test("weight paths refuse absolute and traversal paths", () => {
  assert.throws(() => validateWeightPath("/models/search.pkl"), /stay inside/);
  assert.throws(() => validateWeightPath("models/../search.pkl"), /stay inside/);
  assert.equal(validateWeightPath("models/search.pkl"), "models/search.pkl");
});

test("weight object keys include repository, revision, and relative path", () => {
  assert.equal(
    weightObjectKey("course/team", "a".repeat(40), "models/search.pkl"),
    `weights/course/team/${"a".repeat(40)}/models/search.pkl`,
  );
});

test("weight upload writes the final key once and lets R2 verify the digest", async () => {
  const puts: Array<{ key: string; body: string; sha256: unknown }> = [];
  const bucket = {
    put: async (key: string, value: ReadableStream, options: R2PutOptions) => {
      puts.push({
        key,
        body: await new Response(value).text(),
        sha256: options.sha256,
      });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;

  const uploaded = await uploadWeight(
    bucket,
    "course/team",
    "a".repeat(40),
    "models/search.pkl",
    stream("abc"),
    3,
    SHA256_ABC,
  );

  assert.deepEqual(puts, [
    {
      key: `weights/course/team/${"a".repeat(40)}/models/search.pkl`,
      body: "abc",
      sha256: SHA256_ABC,
    },
  ]);
  assert.deepEqual(uploaded, {
    path: "models/search.pkl",
    size: 3,
    sha256: SHA256_ABC,
    destination: `weights/course/team/${"a".repeat(40)}/models/search.pkl`,
  });
});

test("weight upload reports an R2 digest mismatch as a client error", async () => {
  const bucket = {
    put: async (_key: string, value: ReadableStream) => {
      await new Response(value).arrayBuffer();
      throw new Error("The SHA-256 checksum you specified did not match what we received.");
    },
  } as unknown as R2Bucket;

  await assert.rejects(
    uploadWeight(
      bucket,
      "course/team",
      "a".repeat(40),
      "models/search.pkl",
      stream("different"),
      9,
      SHA256_ABC,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 400 &&
      error.message === "Weight file did not match its digest.",
  );
});

test("weight upload refuses a declared file above 100 MiB before reading", async () => {
  let stored = false;
  const bucket = {
    put: async () => {
      stored = true;
      throw new Error("unexpected put");
    },
  } as unknown as R2Bucket;

  await assert.rejects(
    uploadWeight(
      bucket,
      "course/team",
      "a".repeat(40),
      "models/search.pkl",
      new ReadableStream<Uint8Array>(),
      MAX_WEIGHT_BYTES + 1,
      "a".repeat(64),
    ),
    /may not exceed 100 MiB/,
  );
  assert.equal(stored, false);
});

test("weight upload stops a stream that crosses the 100 MiB cap", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 101) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += 1;
    },
  });
  const bucket = {
    put: async (_key: string, value: ReadableStream<Uint8Array>) => {
      const reader = value.getReader();
      while (!(await reader.read()).done) {
        // Discard each chunk so the test checks the stream guard without
        // retaining a 100 MiB response body in memory.
      }
      return {} as R2Object;
    },
  } as unknown as R2Bucket;

  await assert.rejects(
    uploadWeight(
      bucket,
      "course/team",
      "a".repeat(40),
      "models/search.pkl",
      body,
      null,
      "a".repeat(64),
    ),
    /may not exceed 100 MiB/,
  );
});

test("the report paths become a digest-bound R2 manifest", async () => {
  const sha = "a".repeat(40);
  const digest = Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
  const objects = new Map<string, R2Object | null>([
    [
      `weights/course/team/${sha}/models/present.pkl`,
      { size: 12, checksums: { sha256: digest } } as R2Object,
    ],
    [`weights/course/team/${sha}/models/committed.pkl`, null],
  ]);
  const bucket = {
    head: async (key: string) => objects.get(key) ?? null,
  } as unknown as R2Bucket;

  assert.deepEqual(
    await weightManifest(bucket, "course/team", sha, [
      "models/present.pkl",
      "models/committed.pkl",
    ], [{ path: "models/present.pkl", sha256: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" }]),
    [
      {
        path: "models/present.pkl",
        size: 12,
        sha256: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      },
    ],
  );
});

test("a newer report rejects stale stored bytes and accepts its completed upload", async () => {
  const object: R2Object = {
    key: "model.pkl", version: "1", size: 3, etag: "etag", httpEtag: '"etag"',
    uploaded: new Date(), checksums: { sha256: new Uint8Array(32).buffer, toJSON: () => ({}) },
    storageClass: "Standard", writeHttpMetadata: () => {},
  };
  const bucket = { head: async () => object };
  const required = [{ path: "model.pkl", sha256: SHA256_ABC }];
  await assert.rejects(
    weightManifest(bucket, "course/team", "a".repeat(40), ["model.pkl"], required),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 409 &&
      /does not match this report; sync the report again/.test(error.message),
  );
  // A legacy report cannot prove that even an existing object belongs to it.
  await assert.rejects(
    weightManifest(bucket, "course/team", "a".repeat(40), ["model.pkl"], null),
    /doesn't identify its uploaded weights/,
  );
  object.checksums.sha256 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
  assert.deepEqual(
    await weightManifest(bucket, "course/team", "a".repeat(40), ["model.pkl"], required),
    [{ path: "model.pkl", sha256: SHA256_ABC, size: 3 }],
  );
});

test("manifest validates provenance even without a storage binding", async () => {
  await assert.rejects(
    weightManifest(undefined, "course/team", "a".repeat(40), ["model.pkl"], null),
    /doesn't identify its uploaded weights/,
  );
  await assert.rejects(
    weightManifest(undefined, "course/team", "a".repeat(40), ["model.pkl"],
      [{ path: "model.pkl", sha256: SHA256_ABC }]),
    /Weight storage is not configured/,
  );
  assert.deepEqual(await weightManifest(undefined, "course/team", "a".repeat(40), ["model.pkl"], []), []);
  assert.deepEqual(await weightManifest(undefined, "course/team", "a".repeat(40), [], null), []);
});

test("required uploads without checksums are rejected", async () => {
  const object: R2Object = {
    key: "model.pkl", version: "1", size: 3, etag: "etag", httpEtag: '"etag"',
    uploaded: new Date(), checksums: { toJSON: () => ({}) },
    storageClass: "Standard", writeHttpMetadata: () => {},
  };
  await assert.rejects(
    weightManifest({ head: async () => object }, "course/team", "a".repeat(40),
      ["model.pkl"], [{ path: "model.pkl", sha256: SHA256_ABC }]),
    /has no SHA-256 checksum; sync the report again/,
  );
});

test("incomplete sync cannot produce a dispatch manifest", async () => {
  await assert.rejects(
    weightManifest({ head: async () => null }, "course/team", "a".repeat(40),
      ["model.pkl"], [{ path: "model.pkl", sha256: SHA256_ABC }]),
    /Required weight model.pkl has not been uploaded; sync the report again/,
  );
});

test("legacy missing objects require resync rather than imply committed weights", async () => {
  for (const provenance of [undefined, null]) {
    await assert.rejects(
      weightManifest({ head: async () => null }, "course/team", "a".repeat(40),
        ["model.pkl"], provenance),
      /doesn't identify its uploaded weights; update the CLI and sync the report again/,
    );
  }
});

test("proven committed weights never read stale R2 overrides", async () => {
  const bucket = { head: async () => { throw new Error("must not read committed weights"); } };
  assert.deepEqual(
    await weightManifest(bucket, "course/team", "a".repeat(40), ["model.pkl"], []),
    [],
  );
});

test("uploads outside weightsUsed are rejected before R2 reads", async () => {
  await assert.rejects(
    weightManifest({ head: async () => { throw new Error("unexpected read"); } },
      "course/team", "a".repeat(40), ["model.pkl"], [{ path: "other.pkl", sha256: SHA256_ABC }]),
    /invalid weight provenance/,
  );
});

test("duplicate required uploads are rejected before R2 reads", async () => {
  const required = { path: "model.pkl", sha256: SHA256_ABC };
  await assert.rejects(
    weightManifest({ head: async () => { throw new Error("unexpected read"); } },
      "course/team", "a".repeat(40), [required.path], [required, required]),
    /invalid weight provenance/,
  );
});

test("a report with more than eight weight paths is refused before R2 reads", async () => {
  let heads = 0;
  const bucket = {
    head: async () => {
      heads += 1;
      return null;
    },
  } as unknown as R2Bucket;

  await assert.rejects(
    weightManifest(
      bucket,
      "course/team",
      "a".repeat(40),
      Array.from({ length: 9 }, (_, index) => `models/${index}.pkl`),
    ),
    /names 9 weight files/,
  );
  assert.equal(heads, 0);
});

test("prepared runs omit the weight manifest from the job", () => {
  const parts = runParts("official");
  const job = buildRunJob(
    { PUBLIC_ORIGIN: "https://portal.example.com", EXECUTION_PROVIDER: "modal" } as never,
    parts.run,
    parts.team,
    parts.benchmark,
    [{ path: "models/search.pkl", size: 3, sha256: SHA256_ABC }],
  );
  assert.equal("weights" in job, false);
});

test("weight download signatures can use the 900-second prepare window", async () => {
  const payload = "/api/v1/runs/run_1/weights/models/search.pkl";
  const timestamp = String(Math.floor(Date.now() / 1_000) - 600);
  const secret = "runner-secret";
  const headers = new Map([
    ["X-Cogworks-Key-Id", "runner-v1"],
    ["X-Cogworks-Timestamp", timestamp],
    ["X-Cogworks-Signature", `v1=${await hmacSignature(secret, timestamp, payload)}`],
  ]);
  const context = {
    env: { RUNNER_SIGNING_SECRET: secret },
    req: { header: (name: string) => headers.get(name) },
  } as never;

  await assert.rejects(verifyRunnerSignature(context, payload), /timestamp is invalid/);
  await verifyRunnerSignature(context, payload, 900);
});
