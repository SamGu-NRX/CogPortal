import { MAX_WEIGHT_BYTES, type WeightFile } from "@cogworks/contracts/protocol";
import { LocalReportWeightsSchema, type LocalReportInput } from "@cogworks/contracts/schema";
import { ApiHttpError } from "../http/errors";

export { MAX_WEIGHT_BYTES };

const SHA256_HEX = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const REPOSITORY_FULL_NAME = /^[^/\s]+\/[^/\s]+$/;
// A backslash is a separator on the machine that unpacks these files, and a
// control byte cannot survive a round trip through a shell or an archive.
const UNSAFE_IN_PATH = /[\\\u0000-\u001f\u007f]/;

function invalidWeightPath(): ApiHttpError {
  return new ApiHttpError(400, "invalid_request", "Weight path must stay inside the repository.");
}

/**
 * Canonical, never normalized. A path that would have to be rewritten to be
 * safe is refused instead, so one file has exactly one spelling and two
 * spellings can never name the same stored object.
 */
export function validateWeightPath(path: string): string {
  const segments = path.split("/");
  if (
    !path ||
    UNSAFE_IN_PATH.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw invalidWeightPath();
  }
  return path;
}

function decodeWeightSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw invalidWeightPath();
  }
  // `%252F` names a literal `%2F`; `%2F` would introduce a path separator.
  if (decoded.includes("/")) throw invalidWeightPath();
  return decoded;
}

/**
 * The relative weight path out of a wildcard route.
 *
 * Hono does not capture `*` as a parameter, so `c.req.param("*")` is always
 * undefined, and `c.req.path` is decoded with `decodeURI`, which resolves
 * `%20` but leaves `%23` and `%3F` encoded. Neither one gives back the path the
 * CLI and the runner encoded with `quote(path, safe="/")`. The raw pathname
 * does: the matched pattern says how many leading segments belong to the route,
 * and each remaining segment is decoded exactly once.
 */
export function weightPathFromRoute(routePath: string, requestUrl: string): string {
  const pattern = routePath.split("/");
  if (pattern.at(-1) !== "*") {
    throw new ApiHttpError(500, "provider_unconfigured", "Weight routes must end in a wildcard.");
  }
  const encoded = new URL(requestUrl).pathname.split("/").slice(pattern.length - 1);
  return validateWeightPath(encoded.map(decodeWeightSegment).join("/"));
}

export function parseWeightDigest(sha256: string | null | undefined): string {
  if (!sha256 || !SHA256_HEX.test(sha256)) {
    throw new ApiHttpError(
      400,
      "invalid_request",
      "X-Cogworks-Weight-SHA256 must be a lowercase 64-character SHA-256 digest.",
    );
  }
  return sha256;
}

/**
 * How many bytes the upload promises to send.
 *
 * R2 will only accept a stream whose length is already known, so this is not a
 * hint we can do without; an upload that does not declare one is refused before
 * anything is read.
 */
function parseWeightLength(contentLength: string | null | undefined): number {
  if (contentLength == null) {
    throw new ApiHttpError(
      400,
      "invalid_request",
      "Weight uploads need a Content-Length header; update the CLI and sync the report again.",
    );
  }
  const size = Number(contentLength);
  if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(size)) {
    throw new ApiHttpError(400, "invalid_request", "Content-Length must be a whole number of bytes.");
  }
  if (size > MAX_WEIGHT_BYTES) {
    throw new ApiHttpError(413, "invalid_request", "Weight files may not exceed 100 MiB.");
  }
  return size;
}

function locator(repositoryFullName: string, sha: string): string {
  // Both halves are fixed-shape and slash-free, which is what keeps the
  // segments after them unambiguous. `fullName` locates a repository; it is
  // not proof of identity, since GitHub lets a name move between repositories.
  if (!REPOSITORY_FULL_NAME.test(repositoryFullName) || !COMMIT_SHA.test(sha)) {
    throw new ApiHttpError(400, "invalid_request", "Weight storage needs a repository and a revision.");
  }
  return `${repositoryFullName}/${sha}`;
}

/**
 * Where one exact byte string lives.
 *
 * The digest is a key segment, so uploading a changed file at the same path
 * writes a new object rather than replacing bytes an already-dispatched run
 * recorded. It sits above the student's path so that no path can spell another
 * weight's key, and the whole namespace is separate from the pre-digest
 * `weights/` one so a new key can never collide with an old one.
 *
 * The key is only a string. What binds it to the bytes is that this same
 * digest is passed to `bucket.put(..., { sha256 })`, so R2 refuses the write
 * unless the bytes hash to it.
 */
export function weightObjectKey(
  repositoryFullName: string,
  sha: string,
  path: string,
  sha256: string,
): string {
  return `weight-objects/${locator(repositoryFullName, sha)}/${parseWeightDigest(sha256)}/${validateWeightPath(path)}`;
}

/**
 * The mutable key this portal wrote before weights were content-addressed.
 * Reads only, best effort: a second upload of the same path overwrote whatever
 * was here, so a hit counts only when its checksum still equals the digest the
 * report or the dispatched job recorded. Nothing writes here any more.
 */
function legacyWeightObjectKey(repositoryFullName: string, sha: string, path: string): string {
  return `weights/${locator(repositoryFullName, sha)}/${validateWeightPath(path)}`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type StoredObject = { size: number; checksums: { sha256?: ArrayBuffer } };

function storedBytesMatch(object: StoredObject, weight: WeightFile): boolean {
  const digest = object.checksums.sha256;
  return object.size === weight.size && digest != null && hex(digest) === weight.sha256;
}

export type RecordedWeightLookup<T> =
  | { status: "missing" }
  | { status: "mismatched" }
  | { status: "matched"; object: T };

/**
 * Resolve a weight a dispatched job recorded, at its content-addressed key and
 * then, only if nothing is there, at the pre-digest key. An object that exists
 * but does not carry the recorded size and checksum is a refusal, never a
 * reason to look somewhere else.
 */
async function locateRecordedWeight<T extends StoredObject>(
  read: (key: string) => Promise<T | null>,
  repositoryFullName: string,
  sha: string,
  weight: WeightFile,
): Promise<RecordedWeightLookup<T>> {
  const object = await read(weightObjectKey(repositoryFullName, sha, weight.path, weight.sha256));
  if (object) {
    return storedBytesMatch(object, weight) ? { status: "matched", object } : { status: "mismatched" };
  }
  const legacy = await read(legacyWeightObjectKey(repositoryFullName, sha, weight.path));
  if (!legacy) return { status: "missing" };
  return storedBytesMatch(legacy, weight) ? { status: "matched", object: legacy } : { status: "mismatched" };
}

export function headRecordedWeight(
  bucket: Pick<R2Bucket, "head">,
  repositoryFullName: string,
  sha: string,
  weight: WeightFile,
): Promise<RecordedWeightLookup<R2Object>> {
  return locateRecordedWeight((key) => bucket.head(key), repositoryFullName, sha, weight);
}

/**
 * The body for a recorded weight, checked on the object that will actually be
 * streamed. A `head` before an unchecked `get` would attest to a different
 * read than the one the runner receives.
 */
export async function readRecordedWeight(
  bucket: Pick<R2Bucket, "get">,
  repositoryFullName: string,
  sha: string,
  weight: WeightFile,
): Promise<R2ObjectBody> {
  const found = await locateRecordedWeight(
    (key) => bucket.get(key),
    repositoryFullName,
    sha,
    weight,
  );
  if (found.status === "missing") {
    throw new ApiHttpError(404, "not_found", "Weight file not found.");
  }
  if (found.status === "mismatched") {
    throw new ApiHttpError(
      409,
      "invalid_request",
      `Stored weight ${weight.path} is not the file this run recorded.`,
    );
  }
  return found.object;
}

/**
 * The client's fault, stated in its own terms, or null when the failure belongs
 * to storage and should surface as an error. The first two messages are
 * workerd's own wording for a body that does not match its declared length.
 */
function uploadRefusal(error: unknown): ApiHttpError | null {
  if (!(error instanceof Error)) return null;
  if (/did not see all expected bytes/i.test(error.message)) {
    return new ApiHttpError(
      400,
      "invalid_request",
      "The weight file ended before Content-Length bytes arrived; sync the report again.",
    );
  }
  if (/too many bytes/i.test(error.message)) {
    return new ApiHttpError(
      400,
      "invalid_request",
      "The weight file sent more bytes than Content-Length; sync the report again.",
    );
  }
  if (
    error.name === "BadDigest" ||
    /bad.?digest|checksum.*did not match|did not match.*checksum/i.test(error.message)
  ) {
    return new ApiHttpError(400, "invalid_request", "Weight file did not match its digest.");
  }
  return null;
}

export async function uploadWeight(
  bucket: Pick<R2Bucket, "put">,
  repositoryFullName: string,
  sha: string,
  path: string,
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null | undefined,
  sha256: string | null | undefined,
): Promise<{ path: string; size: number; sha256: string; destination: string }> {
  const digest = parseWeightDigest(sha256);
  const destination = weightObjectKey(repositoryFullName, sha, path, digest);
  if (!body) throw new ApiHttpError(400, "invalid_request", "Weight file body is missing.");
  const size = parseWeightLength(contentLength);

  // R2 rejects a body of unknown length, which a `TransformStream` always is,
  // so the size guard cannot live in a transform. `FixedLengthStream` is the
  // known length and enforces it, failing the writer when the body runs short
  // or long; the declared length was already capped above.
  const fixed = new FixedLengthStream(size);
  const pumping = new AbortController();
  // Both halves can fail, and each one's rejection is observed here rather than
  // left to surface as an unhandled promise.
  const pumped = body
    .pipeTo(fixed.writable, { signal: pumping.signal })
    .then(() => null, (error: unknown) => error);

  let storageError: unknown;
  try {
    // The digest that names the key is the digest R2 checks the bytes against,
    // so a successful write is what binds the key to its contents.
    await bucket.put(destination, fixed.readable, { sha256: digest });
  } catch (error) {
    storageError = error;
  }
  if (storageError !== undefined) {
    // Releasing the read half is what actually stops the pump: a writer already
    // parked on a full stream ignores an abort until its current write settles.
    // The abort covers a pump that has not parked yet, and `cancel` fails
    // harmlessly if `put` still holds the stream.
    void fixed.readable.cancel().catch(() => {});
    pumping.abort();
    // A length failure arrives here too, since it errors the half `put` reads.
    throw uploadRefusal(storageError) ?? storageError;
  }
  // A body longer than its declared length can satisfy the write and fail the
  // writer afterwards, so a successful `put` is not yet a successful upload.
  const pumpError = await pumped;
  if (pumpError) throw uploadRefusal(pumpError) ?? pumpError;
  return { path, size, sha256: digest, destination };
}

export async function weightManifest(
  bucket: Pick<R2Bucket, "head"> | undefined,
  repositoryFullName: string,
  sha: string,
  paths: string[],
  weightsUploaded?: LocalReportInput["weightsUploaded"],
): Promise<WeightFile[]> {
  if (!LocalReportWeightsSchema.safeParse({ weightsUsed: paths, weightsUploaded }).success) {
    throw new ApiHttpError(409, "invalid_request", "The report has invalid weight provenance; sync the report again.");
  }
  // The 2026 corpus has at most three candidate weight files in one repository,
  // and discovery loads one. Eight catches a broken report before dispatch.
  if (paths.length > 8) {
    throw new ApiHttpError(
      409,
      "invalid_request",
      `The newest synced report names ${paths.length} weight files; hosted runs support at most 8.`,
    );
  }

  if (weightsUploaded == null && paths.length > 0) {
    throw new ApiHttpError(409, "invalid_request", "This report doesn't identify its uploaded weights; update the CLI and sync the report again.");
  }
  if (!bucket && weightsUploaded?.length) {
    throw new ApiHttpError(501, "provider_unconfigured", "Weight storage is not configured.");
  }
  if (!bucket) return [];
  const weights: WeightFile[] = [];
  // Explicit provenance excludes committed paths even if R2 has an older override.
  for (const { path, sha256 } of weightsUploaded ?? []) {
    // Only on a miss, and only for the path this report named: see
    // `legacyWeightObjectKey`. An object at the content-addressed key that
    // fails the checks below is refused rather than looked up again.
    const object = (await bucket.head(weightObjectKey(repositoryFullName, sha, path, sha256)))
      ?? (await bucket.head(legacyWeightObjectKey(repositoryFullName, sha, path)));
    if (!object) {
      throw new ApiHttpError(
        409,
        "invalid_request",
        `Required weight ${path} has not been uploaded; sync the report again.`,
      );
    }
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
    if (hex(digest) !== sha256) {
      throw new ApiHttpError(409, "invalid_request", `Stored weight ${path} does not match this report; sync the report again.`);
    }
    weights.push({ path, size: object.size, sha256 });
  }
  return weights;
}
