import { MAX_WEIGHT_BYTES, type WeightFile } from "@cogworks/contracts/protocol";
import { ApiHttpError } from "../http/errors";

export { MAX_WEIGHT_BYTES };

export function validateWeightPath(path: string): string {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new ApiHttpError(400, "invalid_request", "Weight path must stay inside the repository.");
  }
  return path;
}

export function weightPrefix(repositoryFullName: string, sha: string): string {
  return `weights/${repositoryFullName}/${sha}/`;
}

export function weightObjectKey(repositoryFullName: string, sha: string, path: string): string {
  return weightPrefix(repositoryFullName, sha) + validateWeightPath(path);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class WeightTooLargeError extends Error {}
class WeightLengthMismatchError extends Error {}

function isDigestMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "BadDigest" ||
      /bad.?digest|checksum.*did not match|did not match.*checksum/i.test(error.message))
  );
}

export async function uploadWeight(
  bucket: R2Bucket,
  repositoryFullName: string,
  sha: string,
  path: string,
  body: ReadableStream<Uint8Array> | null,
  contentLength: number | null,
  sha256: string | null,
): Promise<{ path: string; size: number; sha256: string; destination: string }> {
  validateWeightPath(path);
  if (!body) throw new ApiHttpError(400, "invalid_request", "Weight file body is missing.");
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ApiHttpError(
      400,
      "invalid_request",
      "X-Cogworks-Weight-SHA256 must be a lowercase 64-character SHA-256 digest.",
    );
  }
  if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new ApiHttpError(400, "invalid_request", "Content-Length must be a non-negative integer.");
  }
  if (contentLength != null && contentLength > MAX_WEIGHT_BYTES) {
    throw new ApiHttpError(413, "invalid_request", "Weight files may not exceed 100 MiB.");
  }

  let size = 0;
  const bounded = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > MAX_WEIGHT_BYTES) throw new WeightTooLargeError();
        controller.enqueue(chunk);
      },
      flush() {
        if (contentLength != null && size !== contentLength) {
          throw new WeightLengthMismatchError();
        }
      },
    }),
  );
  const destination = weightObjectKey(repositoryFullName, sha, path);

  try {
    await bucket.put(destination, bounded, { sha256 });
    return { path, size, sha256, destination };
  } catch (error) {
    if (error instanceof WeightTooLargeError) {
      throw new ApiHttpError(413, "invalid_request", "Weight files may not exceed 100 MiB.");
    }
    if (error instanceof WeightLengthMismatchError) {
      throw new ApiHttpError(400, "invalid_request", "Weight file size did not match Content-Length.");
    }
    if (isDigestMismatch(error)) {
      throw new ApiHttpError(400, "invalid_request", "Weight file did not match its digest.");
    }
    throw error;
  }
}

export async function weightManifest(
  bucket: R2Bucket,
  repositoryFullName: string,
  sha: string,
  paths: string[],
): Promise<WeightFile[]> {
  // The 2026 corpus has at most three candidate weight files in one repository,
  // and discovery loads one. Eight catches a broken report before dispatch.
  if (paths.length > 8) {
    throw new ApiHttpError(
      409,
      "invalid_request",
      `The newest synced report names ${paths.length} weight files; hosted runs support at most 8.`,
    );
  }

  const weights: WeightFile[] = [];
  for (const path of paths) {
    const object = await bucket.head(weightObjectKey(repositoryFullName, sha, path));
    // A missing object was committed at the report's revision and travels in
    // the repository archive, so only R2-backed files belong in this manifest.
    if (!object) continue;
    if (object.size > MAX_WEIGHT_BYTES) {
      throw new ApiHttpError(413, "invalid_request", "A stored weight file exceeds 100 MiB.");
    }
    const digest = object.checksums.sha256;
    if (!digest) {
      throw new ApiHttpError(
        409,
        "invalid_request",
        `Stored weight ${path} has no SHA-256 checksum; sync the report again.`,
      );
    }
    weights.push({ path, size: object.size, sha256: hex(digest) });
  }
  return weights;
}
