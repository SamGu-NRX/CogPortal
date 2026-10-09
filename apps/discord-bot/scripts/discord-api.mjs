// Discord REST plumbing for the scripts in this directory.
//
// register-commands.mjs used to call fetch inline with no timeout: a proxy
// returning an HTML error page made response.json() throw a bare SyntaxError
// with no status or URL, and a hung request hung the script. This module turns
// every failure mode into a DiscordApiError that says what happened and the one
// next action. Request headers, including the Authorization value, are never
// copied into an error message or property.

import { z } from "zod";

/** Response body characters kept in error messages and the body property. */
const BODY_SLICE_LIMIT = 500;

/** Default ceiling for one discordFetchJson call, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Next-action hints for the known Discord API statuses. A status missing from
 * this map gets no hint; the status, method, URL, and body slice still
 * identify the failure.
 *
 * @type {Map<number, string>}
 */
const HINTS_BY_STATUS = new Map([
  [401, "check DISCORD_BOT_TOKEN"],
  [403, "check the application scopes and permissions"],
  [404, "check the application and guild IDs"],
  [429, "rate limited, retry later"],
]);

/**
 * Error for every Discord REST failure mode: non-ok response, non-JSON body,
 * timeout, abort, or network failure. Carries the request context the caller
 * needs to act. Never contains request header values.
 */
export class DiscordApiError extends Error {
  /**
   * @param {string} message what happened and the one next action.
   * @param {{ status?: number, method?: string, url?: string, body?: string, cause?: unknown }} [details]
   *     status: HTTP status code, when a response arrived.
   *     method: HTTP method of the request.
   *     url: request URL.
   *     body: response body slice of at most 500 characters, when a response arrived.
   *     cause: the underlying error, when one exists.
   */
  constructor(message, details = {}) {
    super(message, { cause: details.cause });
    this.name = "DiscordApiError";
    this.status = details.status;
    this.method = details.method;
    this.url = details.url;
    this.body = details.body;
  }
}

/**
 * Fetch a Discord REST endpoint and return the parsed JSON body.
 *
 * The request always carries a timeout signal, and the caller may pass its own
 * AbortSignal in init.signal; whichever fires first cancels the call. A
 * non-ok response, a non-JSON body, a timeout, an abort, or a network failure
 * all throw DiscordApiError with the method, URL, and one next action.
 *
 * @param {string} url request URL.
 * @param {RequestInit} [init] fetch init; the signal option is combined with
 *     the timeout signal, not replaced.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options] pass a
 *     fetchImpl to inject a fake for tests; timeoutMs caps the whole call
 *     (default 30000).
 * @returns {Promise<unknown>} the parsed JSON body.
 * @throws {DiscordApiError} the response is not ok; the message carries the
 *     status, method, URL, a body slice of at most 500 characters, and for
 *     known statuses a next-action hint.
 * @throws {DiscordApiError} an ok response has a body that is not JSON; the
 *     message carries the status and a body slice.
 * @throws {DiscordApiError} the call timed out, was aborted, or the network
 *     failed; the message names the timeout or the underlying cause.
 */
export async function discordFetchJson(url, init = {}, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const method = init.method ?? "GET";
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // AbortSignal.any keeps whichever abort reason wins, so a caller abort and
  // a timeout stay distinguishable in the failure path below.
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    throw networkFailure(error, {
      method,
      url,
      timeoutMs,
      callerSignal: init.signal,
      signal,
      responsePhase: false,
    });
  }

  let bodyText;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw networkFailure(error, {
      method,
      url,
      timeoutMs,
      callerSignal: init.signal,
      signal,
      responsePhase: true,
    });
  }

  if (!response.ok) {
    const body = bodyText.slice(0, BODY_SLICE_LIMIT);
    const hint = HINTS_BY_STATUS.get(response.status);
    const hintPart = hint ? ` (${hint})` : "";
    throw new DiscordApiError(
      `Discord API call failed (${response.status} ${method} ${url}): ${body}${hintPart}`,
      { status: response.status, method, url, body },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    const body = bodyText.slice(0, BODY_SLICE_LIMIT);
    throw new DiscordApiError(`Discord API returned a non-JSON response (${response.status}): ${body}`, {
      status: response.status,
      method,
      url,
      body,
    });
  }

  return parsed;
}

/**
 * Wrap a fetch or body-read failure in a DiscordApiError that names the
 * timeout or the underlying cause.
 *
 * @param {unknown} error the thrown error.
 * @param {{ method: string, url: string, timeoutMs: number, callerSignal: AbortSignal | undefined, signal: AbortSignal, responsePhase: boolean }} context
 * @returns {DiscordApiError}
 */
function networkFailure(error, { method, url, timeoutMs, callerSignal, signal, responsePhase }) {
  const causeMessage = error instanceof Error ? error.message : String(error);

  // A fake fetchImpl may reject with the reason itself instead of observing
  // the signal, so check both the error and the combined signal's reason.
  const timedOut = error?.name === "TimeoutError" || signal?.reason?.name === "TimeoutError";
  if (timedOut) {
    return new DiscordApiError(
      `Discord API call timed out after ${timeoutMs}ms (${method} ${url}). If this endpoint is slow, pass a larger timeoutMs.`,
      { method, url, cause: error },
    );
  }

  const abortedByCaller = error?.name === "AbortError" || callerSignal?.aborted === true;
  if (abortedByCaller) {
    return new DiscordApiError(`Discord API call was aborted (${method} ${url}): ${causeMessage}`, {
      method,
      url,
      cause: error,
    });
  }

  const prefix = responsePhase
    ? "Discord API response body could not be read"
    : "Discord API call failed before a response arrived";
  return new DiscordApiError(
    `${prefix} (${method} ${url}): ${causeMessage}. Check the network connection and retry.`,
    { method, url, cause: error },
  );
}

/**
 * Schema for one application command in Discord's command-list responses.
 * id must be a snowflake string; type and name may be missing; unknown fields
 * are kept so callers can read fields like handler without a second schema.
 *
 * @type {import("zod").ZodType}
 */
const applicationCommandSchema = z.looseObject({
  id: z.string().regex(/^\d+$/, "must be a digit string (Discord snowflake)"),
  type: z.union([z.number(), z.string()]).optional(),
  name: z.union([z.string(), z.number()]).optional(),
});

const applicationCommandListSchema = z.array(applicationCommandSchema);

/**
 * Validate the command list returned by the Discord application-commands
 * endpoints. Tolerates unknown extra fields on each element.
 *
 * @param {unknown} value the parsed JSON body of a commands list response.
 * @returns {Array<{ id: string, type?: number | string, name?: string, [key: string]: unknown }>}
 *     the validated commands, unknown fields preserved.
 * @throws {DiscordApiError} the value is not an array or an element has the
 *     wrong shape; the message names the first bad paths.
 */
export function parseApplicationCommands(value) {
  const result = applicationCommandListSchema.safeParse(value);
  if (!result.success) {
    throw new DiscordApiError(
      `Discord command list response has an unexpected shape: ${shapeDetail(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Summarize the first zod issues into one bounded detail string, so a list of
 * hundreds of bad elements cannot flood the message.
 *
 * @param {import("zod").ZodError} error
 * @returns {string}
 */
function shapeDetail(error) {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(list)";
    return `${path}: ${issue.message}`;
  });
  const hidden = error.issues.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden} more)` : "";
  return shown.join("; ") + suffix;
}
