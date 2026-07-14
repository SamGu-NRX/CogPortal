import type { Context, ErrorHandler } from "hono";
import { ApiErrorSchema } from "@cogworks/contracts/schema";
import type { ApiErrorCode } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";

type ApiStatus = 400 | 401 | 403 | 404 | 409 | 410 | 500 | 501 | 502;

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

export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof ApiHttpError) {
    return errorResponse(c, error.status, error.code, error.message);
  }

  console.error("Unhandled API error", error instanceof Error ? error.message : "unknown error");
  return errorResponse(
    c,
    500,
    "provider_unconfigured",
    "The request could not be completed by the configured backend.",
  );
};
