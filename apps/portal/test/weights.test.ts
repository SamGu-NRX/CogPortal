import assert from "node:assert/strict";
import test from "node:test";
import { buildRunJob, hmacSignature } from "../worker/execution/runner.ts";
import { verifyRunnerSignature } from "../worker/routes/runner-events.ts";
import {
  MAX_WEIGHT_BYTES,
  uploadWeight,
  validateWeightPath,
  weightManifest,
  weightObjectKey,
  weightPathFromRoute,
} from "../worker/services/weights.ts";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/**
 * `FixedLengthStream` is a workerd global with no Node equivalent, so uploads
 * cannot be exercised here without one. This stands in for its length
 * enforcement and its two error messages only, which is enough for the tests
 * below. It does not reproduce the thing that made it necessary, that R2
 * refuses a body of unknown length, so nothing here can prove an upload works;
 * only a run under workerd can.
 */
class FixedLengthStreamShim {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedLength: number) {
    let seen = 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expectedLength) {
          throw new TypeError("Attempt to write too many bytes through a FixedLengthStream.");
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expectedLength) {
          throw new TypeError("FixedLengthStream did not see all expected bytes before close().");
        }
      },
    });
    this.readable = readable;
    this.writable = writable;
  }
}
Object.assign(globalThis, { FixedLengthStream: FixedLengthStreamShim });

function stream(body: string): ReadableStream<Uint8Array> {
  return new Blob([body]).stream();
}

function hexBytes(digest: string): ArrayBuffer {
  const bytes = digest.match(/../g);
  assert.ok(bytes, "digest must contain hexadecimal bytes");
  return Uint8Array.from(bytes.map((byte) => parseInt(byte, 16))).buffer;
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

test("reports without uploaded weights need no object storage", async () => {
  assert.deepEqual(await weightManifest(undefined, "course/team", "a".repeat(40), [], []), []);
});

test("weight paths refuse anything that would need rewriting to be safe", () => {
  for (const path of [
    "", "/models/search.pkl", "models/../search.pkl", "..", ".",
    "models//search.pkl", "models/./search.pkl", "models/search.pkl/", "models\\search.pkl",
  ]) {
    assert.throws(() => validateWeightPath(path), /stay inside/, path);
  }
  // Canonical, not normalized: the one spelling that is already safe survives.
  assert.equal(validateWeightPath("models/search.pkl"), "models/search.pkl");
  assert.equal(validateWeightPath("models/final model.pkl"), "models/final model.pkl");
});

test("the relative path comes from the matched route, not from a wildcard param", () => {
  // `c.req.param("*")` is always undefined in Hono, so both weight routes read
  // an empty path and answered 400 for every request.
  for (const routePath of [
    "/api/v1/runs/:id/weights/*",
    "/api/v1/local-reports/:reportId/weights/*",
  ]) {
    const prefix = `https://portal.example.com${routePath.slice(0, -1).replace(/:\w+/, "r1")}`;
    assert.equal(weightPathFromRoute(routePath, `${prefix}models/search.pkl`), "models/search.pkl");
    // `%2520` names a literal `%20`, not a space.
    assert.equal(weightPathFromRoute(routePath, `${prefix}final%20model.pkl`), "final model.pkl");
    assert.equal(weightPathFromRoute(routePath, `${prefix}final%2520model.pkl`), "final%20model.pkl");
    assert.throws(() => weightPathFromRoute(routePath, prefix), /stay inside/);
    assert.throws(() => weightPathFromRoute(routePath, `${prefix}a//b.pkl`), /stay inside/);
    // An encoded separator would otherwise reach a path nobody declared, and a
    // NUL or a newline would not survive being written to disk.
    for (const encoded of ["a%2Fb.pkl", "a%2fb.pkl", "model%00.pkl", "model%0A.pkl", "model%zz.pkl"]) {
      assert.throws(() => weightPathFromRoute(routePath, prefix + encoded), /stay inside/, encoded);
    }
  }
  assert.throws(
    () => weightPathFromRoute("/api/v1/runs/:id/weights", "https://portal.example.com/api/v1/runs/r1/weights"),
    /end in a wildcard/,
  );
});

test("weight object keys name the content, in a namespace of their own", () => {
  const sha = "a".repeat(40);
  assert.equal(
    weightObjectKey("course/team", sha, "models/search.pkl", SHA256_ABC),
    `weight-objects/course/team/${sha}/${SHA256_ABC}/models/search.pkl`,
  );
  // The digest sits above the student's path, so no path can spell another
  // weight's key, and no key can land in the pre-digest `weights/` namespace.
  assert.equal(
    weightObjectKey("course/team", sha, `${SHA256_ABC}/search.pkl`, SHA256_ABC)
      .startsWith(`weight-objects/course/team/${sha}/${SHA256_ABC}/`),
    true,
  );
  assert.doesNotMatch(weightObjectKey("course/team", sha, "models/search.pkl", SHA256_ABC), /^weights\//);
  for (const [fullName, revision] of [
    ["course", sha], ["course/team/extra", sha], ["course/te am", sha],
    ["course/team", "a".repeat(39)], ["course/team", "A".repeat(40)],
  ]) {
    assert.throws(() => weightObjectKey(fullName, revision, "models/search.pkl", SHA256_ABC),
      /repository and a revision/, `${fullName} ${revision}`);
  }
  assert.throws(() => weightObjectKey("course/team", sha, "models/search.pkl", "nope"), /SHA-256 digest/);
});

test("two uploads at one path are two objects, and each report resolves its own", async () => {
  const sha = "a".repeat(40);
  const older = { path: "model.pkl", sha256: SHA256_ABC };
  const newer = { path: "model.pkl", sha256: "b".repeat(64) };
  const stored = new Map<string, R2Object>();
  // SAFETY: uploadWeight supplies a stream and checksum to put; weightManifest
  // calls head and reads only size/checksums. Other R2 properties are not used.
  const bucket = {
    put: async (key: string, value: ReadableStream<Uint8Array>, options: R2PutOptions) => {
      const body = await new Response(value).arrayBuffer();
      stored.set(key, {
        size: body.byteLength,
        checksums: { sha256: hexBytes(String(options.sha256)) },
      } as R2Object);
      return {} as R2Object;
    },
    head: async (key: string) => stored.get(key) ?? null,
  } as unknown as R2Bucket;

  const a = await uploadWeight(bucket, "course/team", sha, older.path, stream("abc"), "3", older.sha256);
  const b = await uploadWeight(bucket, "course/team", sha, newer.path, stream("defghi"), "6", newer.sha256);
  assert.notEqual(a.destination, b.destination);
  assert.equal(stored.size, 2);

  // The older report keeps resolving to the bytes it named after the newer
  // upload exists, which is the whole point of the digest in the key.
  assert.deepEqual(await weightManifest(bucket, "course/team", sha, [older.path], [older]),
    [{ path: "model.pkl", size: 3, sha256: older.sha256 }]);
  assert.deepEqual(await weightManifest(bucket, "course/team", sha, [newer.path], [newer]),
    [{ path: "model.pkl", size: 6, sha256: newer.sha256 }]);
});

test("a manifest falls back to a pre-digest object only when it is the recorded file", async () => {
  const sha = "a".repeat(40);
  const legacyKey = `weights/course/team/${sha}/model.pkl`;
  const required = [{ path: "model.pkl", sha256: SHA256_ABC }];
  const reads: string[] = [];
  const bucketFor = (object: R2Object | null) => ({
    head: async (key: string) => {
      reads.push(key);
      return key === legacyKey ? object : null;
    },
  });

  assert.deepEqual(
    await weightManifest(bucketFor({ size: 3, checksums: { sha256: hexBytes(SHA256_ABC) } } as R2Object),
      "course/team", sha, ["model.pkl"], required),
    [{ path: "model.pkl", size: 3, sha256: SHA256_ABC }],
  );
  assert.deepEqual(reads, [
    `weight-objects/course/team/${sha}/${SHA256_ABC}/model.pkl`,
    legacyKey,
  ]);
  await assert.rejects(
    weightManifest(bucketFor({ size: 3, checksums: { sha256: hexBytes("c".repeat(64)) } } as R2Object),
      "course/team", sha, ["model.pkl"], required),
    /does not match this report/,
  );
  await assert.rejects(
    weightManifest(bucketFor({ size: 3, checksums: {} } as R2Object),
      "course/team", sha, ["model.pkl"], required),
    /has no SHA-256 checksum/,
  );
});

test("a content-addressed object that fails its checks is refused, never re-read elsewhere", async () => {
  const sha = "a".repeat(40);
  const reads: string[] = [];
  const bucket = {
    head: async (key: string) => {
      reads.push(key);
      return { size: 3, checksums: {} } as R2Object;
    },
  };
  await assert.rejects(
    weightManifest(bucket, "course/team", sha, ["model.pkl"], [{ path: "model.pkl", sha256: SHA256_ABC }]),
    /has no SHA-256 checksum/,
  );
  assert.deepEqual(reads, [`weight-objects/course/team/${sha}/${SHA256_ABC}/model.pkl`]);
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
    "3",
    SHA256_ABC,
  );

  // The digest in the key and the digest R2 verifies are the same string, so
  // an accepted write is what binds this key to these bytes.
  const key = `weight-objects/course/team/${"a".repeat(40)}/${SHA256_ABC}/models/search.pkl`;
  assert.deepEqual(puts, [{ key, body: "abc", sha256: SHA256_ABC }]);
  assert.deepEqual(uploaded, {
    path: "models/search.pkl",
    size: 3,
    sha256: SHA256_ABC,
    destination: key,
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
      "9",
      SHA256_ABC,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 400 &&
      error.message === "Weight file did not match its digest.",
  );
});

test("an upload that does not declare its length is refused before any read", async () => {
  // R2 will not take a body whose length it does not know, so there is no cap
  // left to enforce mid-stream: an undeclared or unusable length has to be
  // refused here rather than after 100 MiB have already been read.
  const body = new Blob(["abc"]).stream();
  const bucket = {
    put: async () => {
      throw new Error("unexpected put");
    },
  };

  for (const [contentLength, message] of [
    [undefined, /need a Content-Length header/],
    [null, /need a Content-Length header/],
    ["", /whole number of bytes/],
    ["  3", /whole number of bytes/],
    ["3.5", /whole number of bytes/],
    ["-1", /whole number of bytes/],
    ["1e3", /whole number of bytes/],
    ["nine", /whole number of bytes/],
    [String(Number.MAX_SAFE_INTEGER + 2), /whole number of bytes/],
    [String(MAX_WEIGHT_BYTES + 1), /may not exceed 100 MiB/],
  ] satisfies Array<[string | null | undefined, RegExp]>) {
    await assert.rejects(
      uploadWeight(bucket, "course/team", "a".repeat(40), "models/search.pkl", body, contentLength, SHA256_ABC),
      message,
      String(contentLength),
    );
  }
  // Nothing piped the body, so it was never read and never partly stored.
  assert.equal(body.locked, false);
});

test("a body that does not match Content-Length is a client error, not a stored object", async () => {
  const stored: string[] = [];
  const bucket = {
    put: async (key: string, value: ReadableStream<Uint8Array>) => {
      await new Response(value).arrayBuffer();
      stored.push(key);
      return {} as R2Object;
    },
  };

  await assert.rejects(
    uploadWeight(bucket, "course/team", "a".repeat(40), "models/search.pkl", stream("ab"), "3", SHA256_ABC),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 400 &&
      /ended before Content-Length bytes/.test(error.message),
  );
  await assert.rejects(
    uploadWeight(bucket, "course/team", "a".repeat(40), "models/search.pkl", stream("abcd"), "3", SHA256_ABC),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 400 &&
      /more bytes than Content-Length/.test(error.message),
  );
  // Whether a long body's write lands before the writer notices the extra
  // bytes is workerd's call, not this shim's. What must hold either way is that
  // the only key a refused upload can reach is the one its declared digest
  // names, so a partial write cannot shadow another report's object.
  const key = `weight-objects/course/team/${"a".repeat(40)}/${SHA256_ABC}/models/search.pkl`;
  assert.deepEqual(stored.filter((written) => written !== key), []);
});

test("a storage failure releases the upload and stays an error", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Never closes. A writer parked here with nothing draining it outlives
      // the request unless the read half is released, which is what an aborted
      // `pipeTo` alone does not do.
      pulls += 1;
      controller.enqueue(new Uint8Array(1));
    },
  });
  const bucket = {
    put: async () => {
      throw new Error("R2 is unavailable");
    },
  };
  const stray: unknown[] = [];
  const collect = (reason: unknown) => stray.push(reason);
  process.on("unhandledRejection", collect);

  try {
    // A storage outage is ours, not the student's, so it keeps its 500.
    await assert.rejects(
      uploadWeight(bucket, "course/team", "a".repeat(40), "models/search.pkl", body, "4096", SHA256_ABC),
      (error: unknown) => error instanceof Error && !("status" in error) && error.message === "R2 is unavailable",
    );
    const settled = pulls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pulls, settled, "the pump kept reading after the upload failed");
    assert.deepEqual(stray, []);
  } finally {
    process.off("unhandledRejection", collect);
  }
});

test("the report paths become a digest-bound R2 manifest", async () => {
  const sha = "a".repeat(40);
  const digest = Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
  const objects = new Map<string, R2Object | null>([
    [
      `weight-objects/course/team/${sha}/000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f/models/present.pkl`,
      { size: 12, checksums: { sha256: digest } } as R2Object,
    ],
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
