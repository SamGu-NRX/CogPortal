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
  // Every environment serializes through the schema, not just development:
  // an undeclared field on a returned object is stripped here rather than
  // shipped because the Worker runs in production. A parse failure is a bug
  // in the route, and the ZodError reaches the handler's 500, which carries
  // nothing from the object (worker/http/errors.ts).
  const body = schema.parse(data);
  // Production keeps stripping, so a student never gets a 500 for a field a
  // service added. Everywhere else (development, the unit tests, the real
  // journeys' Worker) a stripped field is a bug that throws: silent stripping
  // hid it from every test, and the field stayed one schema edit away from
  // shipping. An env-less Hono app in a unit test is strict too.
  if (c.env?.ENVIRONMENT !== "production") {
    const undeclared = strippedKeys(data, body);
    if (undeclared.length > 0) {
      throw new Error(
        `respond(): the answer carries fields its schema doesn't declare (production strips them): ${undeclared.join(", ")}. Declare each in the schema or stop returning it.`,
      );
    }
  }
  return c.json(body, status);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Paths of the keys parsing dropped: keys `input` has that `output` lacks,
 * walking objects and arrays in step. The walk stops where the schema turned
 * the value into something that isn't a plain object or array (a Date, a
 * transform's result). A key whose value is undefined is skipped, because
 * JSON drops it anyway.
 */
function strippedKeys(input: unknown, output: unknown, path = "$"): string[] {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.flatMap((item, i) => (i < output.length ? strippedKeys(item, output[i], `${path}[${i}]`) : []));
  }
  if (!isPlainObject(output) || input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const source = input as Record<string, unknown>;
  return Object.keys(source).flatMap((key) => {
    if (source[key] === undefined) return [];
    if (!Object.hasOwn(output, key)) return [`${path}.${key}`];
    return strippedKeys(source[key], output[key], `${path}.${key}`);
  });
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
