import type { Context, ErrorHandler } from "hono";
import { ApiErrorSchema } from "@cogworks/contracts/schema";
import type { ApiErrorCode } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { isGitHubUnauthorized } from "../github/client";

type ApiStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 500 | 501 | 502;

export class ApiHttpError extends Error {
  constructor(
    public readonly status: ApiStatus,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export function errorResponse(
  c: Context<AppEnv>,
  status: ApiStatus,
  code: ApiErrorCode,
  message: string,
) {
  const data = { error: { code, message } };
  const body = c.env.ENVIRONMENT === "development" ? ApiErrorSchema.parse(data) : data;
  return c.json(body, status);
}

export const GITHUB_SIGN_IN_EXPIRED =
  "GitHub no longer accepts this portal's sign-in for you. Sign out, sign in with GitHub again, and retry this action.";

/**
 * The error a student may read, or null for one only staff should.
 *
 * Every message on an ApiHttpError is written for the student who caused it.
 * Anything else (a D1 failure, a bug, a provider's own text) can carry
 * internals, so it never leaves the Worker. The HTTP handler and the Discord
 * service binding both decide through here, so a refusal reads the same in
 * the browser, the Activity and the bot.
 */
export function publicApiError(error: unknown): ApiHttpError | null {
  if (error instanceof ApiHttpError) return error;
  if (isGitHubUnauthorized(error)) return new ApiHttpError(401, "unauthorized", GITHUB_SIGN_IN_EXPIRED);
  return null;
}

export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  const known = publicApiError(error);
  if (known) return errorResponse(c, known.status, known.code, known.message);

  console.error("Unhandled API error", error instanceof Error ? error.message : "unknown error");
  return errorResponse(
    c,
    500,
    "provider_unconfigured",
    "The request could not be completed by the configured backend.",
  );
};
