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

export async function parseBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await c.req.json());
  } catch {
    throw new ApiHttpError(400, "invalid_request", "The request body is invalid.");
  }
}
