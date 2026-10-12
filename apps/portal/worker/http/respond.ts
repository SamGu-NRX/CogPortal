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

/**
 * One string field of a JSON body, read before the body is validated, for a
 * guard that has to settle who is asking before the route answers anything
 * about what they sent: a signed-out caller, or one on another team, gets
 * the guard's refusal and never a validation error. A body that isn't JSON,
 * or a field that isn't a non-empty string, reads as undefined. The route
 * still validates the whole body after its guard (Hono caches the parse).
 */
export async function guardField(c: Context<AppEnv>, name: string): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function parseBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await c.req.json());
  } catch {
    throw new ApiHttpError(400, "invalid_request", "The request body is invalid.");
  }
}
