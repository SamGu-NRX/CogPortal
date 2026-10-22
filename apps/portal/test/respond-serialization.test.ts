import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { respond } from "../worker/http/respond.ts";

/*
 * respond() serializes through the schema in every environment: an
 * undeclared field on a returned object is stripped before the client reads
 * it, and an answer that fails its schema is the house 500, never the object
 * itself. The journey stack boots its fixture profile as development, so
 * without this test the suite watches a different serializer from
 * production's: a field the production Worker would send never reaches the
 * matrix (PR 114 review, 2026-10-12).
 */

const AnswerSchema = z.object({ teamId: z.string(), note: z.string() });

/** The object a route service returned — declared fields, then the bug. */
function returnedObject() {
  const data: z.infer<typeof AnswerSchema> = { teamId: "team_a", note: "the caller's own note" };
  (data as Record<string, unknown>).scorerInternalNote = "rj-witness-private-note";
  return data;
}

function appFor(env: Partial<Env>) {
  const routes = new Hono<AppEnv>();
  routes.get("/answer", (c) => respond(c, AnswerSchema, returnedObject()));
  routes.get("/broken", (c) => respond(c, AnswerSchema, { teamId: 42, note: "x" } as never));
  const app = new Hono<AppEnv>();
  app.route("/", routes);
  app.onError(handleError);
  return app;
}

async function call(path: string, environment: string) {
  const env = { ENVIRONMENT: environment } as unknown as Env;
  const response = await appFor(env).fetch(new Request(`http://localhost:5173${path}`), env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("production strips an undeclared private field a route returned", async () => {
  const { status, body } = await call("/answer", "production");
  assert.equal(status, 200);
  assert.deepEqual(body, { teamId: "team_a", note: "the caller's own note" });
});

test("development strips the same field", async () => {
  const { body } = await call("/answer", "development");
  assert.equal("scorerInternalNote" in body, false);
});

test("an answer that fails its schema is the house 500 in production, carrying nothing from the object", async () => {
  const { status, body } = await call("/broken", "production");
  assert.deepEqual(body, {
    error: { code: "provider_unconfigured", message: "The request could not be completed by the configured backend." },
  });
  assert.equal(status, 500);
});

test("an answer that fails its schema refuses loudly in development too", async () => {
  const { status, body } = await call("/broken", "development");
  assert.equal(status, 500);
  assert.deepEqual(body, {
    error: { code: "provider_unconfigured", message: "The request could not be completed by the configured backend." },
  });
});
