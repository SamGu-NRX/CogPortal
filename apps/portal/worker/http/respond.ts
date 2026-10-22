import type { Context } from "hono";
import type { z } from "zod";
import { ApiHttpError } from "./errors";
import type { AppEnv } from "../env";

type ResponseStatus = 200 | 201;

export function respond<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
  data: T,
  status: ResponseStatus = 200,
): Response {
  const body = c.env.ENVIRONMENT === "development" ? schema.parse(data) : data;
  return c.json(body, status);
}

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * How many bytes a request body may hold, by what it carries. Every body the
 * Worker reads is counted against one of these, so a request too large to
 * mean anything is refused with 413 instead of being buffered and stored.
 *
 * The weight upload (PUT /v1/local-reports/:id/weights/*) streams to R2 under
 * its own 100 MiB cap (services/weights.ts). GitHub webhooks and Better Auth
 * use the byte reader below so signature verification and auth parsing keep
 * the original bytes.
 */
export const BODY_LIMITS = {
  /**
   * A local report or an event that may carry one: report sync, live-run
   * events (one, or a batch of up to 32 ending in the report), and the
   * hosted runner's callbacks.
   *
   * Measured on 2026-10-12: the largest report a real CLI journey printed is
   * Week 3 language search at no more than 14,436 bytes (CI run 38252289837,
   * all three passes; the printed, indented copy, which is never smaller than
   * the compact body the CLI sends). The largest report fixture is 5,936
   * bytes, and a runner event fixture 621 bytes. 1 MiB is about 70 times
   * the largest measured report. It is also above the most the schemas
   * admit with every length-capped field full: 63 KB for a 32-event batch
   * ending in a report and 107 KB for a runner callback, or 265 KB and
   * 570 KB if every character were written as a JSON escape. Metric help
   * text has no length cap, so this limit is the only bound on it.
   */
  report: 1 * MiB,
  /** GitHub documents a 25 MB webhook payload cap.
   * https://docs.github.com/en/webhooks/webhook-events-and-payloads#webhook-payloads
   */
  githubWebhook: 25_000_000,
  /** Sender maximum unverified: Better Auth documents no request-body cap.
   * https://www.better-auth.com/docs/concepts/api
   * 1 MiB allows room for sign-in fields and OAuth tokens without buffering
   * an arbitrary upload. This allowance has not been measured on real traffic.
   */
  auth: 1 * MiB,
  /**
   * Every other JSON body: forms, team and admin actions, device linking,
   * setup evidence and the live-run start. The largest the CLI sends is
   * setup evidence, measured at 301 bytes; full in every capped field it is
   * 2.9 KB, or 16 KB written entirely as JSON escapes, and the capped
   * fields of every other schema here admit less. 64 KiB is four times the
   * escaped bound.
   */
  control: 64 * KiB,
} as const;
export type BodyLimit = keyof typeof BODY_LIMITS;

function formatBytes(bytes: number): string {
  return bytes % MiB === 0 ? `${bytes / MiB} MiB` : `${bytes / KiB} KiB`;
}

/**
 * The request body as bytes, refused with 413 past its limit.
 *
 * The bytes are counted as they arrive. A declared Content-Length over the
 * limit is refused before anything is read; a missing or understated one
 * can't get past the count, and reading stops at the first byte over.
 *
 * The bytes go into Hono's body cache, so later reads use the bounded copy.
 * If something read the body through Hono first, that cached copy is
 * measured instead. Auth and signature routes must call this before any
 * text parser, since decoding can discard a BOM or replace invalid UTF-8.
 *
 * A body that can't be read is a 400. The stream fails when the client
 * drops mid-upload, and the cached copy fails when the guard's own read
 * did, for that reason or for malformed JSON. Either way the fault is in
 * the request, so a 500 would blame the Worker for it.
 */
export async function readBodyBytes(c: Context<AppEnv>, limit: BodyLimit): Promise<Uint8Array<ArrayBuffer>> {
  const max = BODY_LIMITS[limit];
  const tooLarge = () =>
    new ApiHttpError(413, "invalid_request", `The request body is over the ${formatBytes(max)} this endpoint accepts.`);
  const unreadable = () => new ApiHttpError(400, "invalid_request", "The request body could not be read.");
  if (Number(c.req.header("Content-Length")) > max) throw tooLarge();

  if (Object.keys(c.req.bodyCache).length > 0) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      throw unreadable();
    }
    if (bytes.byteLength > max) throw tooLarge();
    return bytes;
  }
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw unreadable();
    }
    const { done, value } = chunk;
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      // Do not wait for a slow or rejected cancellation before returning 413.
      reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // SAFETY: Hono types the cache as plain values, but its runtime stores the
  // promise and calls .then on it (hono/dist/request.js, #cachedBody).
  (c.req.bodyCache as { arrayBuffer?: Promise<ArrayBuffer> }).arrayBuffer = Promise.resolve(bytes.buffer);
  return bytes;
}

export async function readBodyText(c: Context<AppEnv>, limit: BodyLimit): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(c, limit));
}

/** A 400 names at most this many unknown fields, each cut to this many
 *  characters. The names come from the client, so the answer stays small
 *  whatever it sent. */
const NAMED_FIELDS = 5;
const FIELD_NAME_CHARS = 120;

function fieldName(path: readonly PropertyKey[]): string {
  return path.reduce<string>((name, part) => {
    if (typeof part === "number") return `${name}[${part}]`;
    return name ? `${name}.${String(part)}` : String(part);
  }, "");
}

/** Every key a strict schema refused, by its full path in the body. */
function unknownFields(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => fieldName([...issue.path, key]))
      : [],
  );
}

/**
 * Reads, size-checks and validates a JSON body.
 *
 * Request schemas are strict, so a field the endpoint doesn't declare is a
 * 400 that names it. It used to be dropped, so a client sending a field the
 * portal never stored got a success.
 */
export async function parseBody<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
  limit: BodyLimit = "control",
): Promise<T> {
  const text = await readBodyText(c, limit);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiHttpError(400, "invalid_request", "The request body is invalid.");
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const unknown = unknownFields(parsed.error);
  if (unknown.length > 0) {
    const named = unknown.slice(0, NAMED_FIELDS).map((name) => name.slice(0, FIELD_NAME_CHARS)).join(", ");
    const more = unknown.length > NAMED_FIELDS ? ` and ${unknown.length - NAMED_FIELDS} more` : "";
    throw new ApiHttpError(
      400,
      "invalid_request",
      `The request body has ${unknown.length === 1 ? "a field" : "fields"} this endpoint does not accept: ${named}${more}.`,
    );
  }
  throw new ApiHttpError(400, "invalid_request", "The request body is invalid.");
}
