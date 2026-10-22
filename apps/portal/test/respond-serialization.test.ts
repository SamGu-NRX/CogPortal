import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { respond } from "../worker/http/respond.ts";

/*
 * respond() serializes through the schema in every environment, and an
 * answer that fails its schema is the house 500, never the object itself.
 * An undeclared field on a returned object is stripped in production; in
 * development (which the journey stack boots) and in tests it throws, so a
 * field a service leaks fails loudly instead of being silently dropped where
 * no test can see it (PR 114 review, 2026-10-12 and 2026-10-22).
 */

const AnswerSchema = z.object({ teamId: z.string(), note: z.string() });

/** The object a route service returned — declared fields, then the bug. */
function returnedObject() {
  const data: z.infer<typeof AnswerSchema> = { teamId: "team_a", note: "the caller's own note" };
  (data as Record<string, unknown>).scorerInternalNote = "rj-witness-private-note";
  return data;
}

const NestedSchema = z.object({
  team: z.object({ id: z.string() }),
  members: z.array(z.object({ login: z.string(), role: z.string().optional() })),
  scores: z.record(z.string(), z.number()),
  at: z.date(),
});

type Handler = (c: Context<AppEnv>) => Response;

const HANDLERS: Record<string, Handler> = {
  "/answer": (c) => respond(c, AnswerSchema, returnedObject()),
  "/broken": (c) => respond(c, AnswerSchema, { teamId: 42, note: "x" } as never),
  "/declared": (c) => respond(c, AnswerSchema, { teamId: "team_a", note: "only what the schema names" }),
  "/nested": (c) =>
    respond(c, NestedSchema, {
      team: { id: "team_a", secret: "rj-witness-team-secret" },
      members: [{ login: "rj-a" }, { login: "rj-b", email: "rj-b@dev.local" }],
      scores: { top1: 0.5 },
      at: new Date(0),
    } as never),
  // Keys JSON never ships, and the keys a record keeps: nothing to report.
  "/clean-nested": (c) =>
    respond(c, NestedSchema, {
      team: { id: "team_a", gone: undefined },
      members: [{ login: "rj-a", role: undefined }],
      scores: { top1: 0.5, top5: 0.9 },
      at: new Date(0),
    } as never),
};

async function call(path: string, environment: string | undefined) {
  const app = new Hono<AppEnv>();
  for (const [route, handler] of Object.entries(HANDLERS)) app.get(route, handler);
  let thrown: unknown;
  app.onError((error, c) => {
    thrown = error;
    // handleError reads c.env, which an env-less app doesn't have.
    return c.env ? handleError(error, c) : c.json({}, 500);
  });
  const env = (environment === undefined ? undefined : { ENVIRONMENT: environment }) as unknown as Env;
  const response = await app.fetch(new Request(`http://localhost:5173${path}`), env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, thrown };
}

const HOUSE_500 = {
  error: { code: "provider_unconfigured", message: "The request could not be completed by the configured backend." },
};

test("production strips an undeclared private field a route returned", async () => {
  const { status, body, thrown } = await call("/answer", "production");
  assert.equal(thrown, undefined);
  assert.equal(status, 200);
  assert.deepEqual(body, { teamId: "team_a", note: "the caller's own note" });
});

test("development refuses an answer carrying an undeclared field, naming it, and sends none of the object", async () => {
  const { status, body, thrown } = await call("/answer", "development");
  assert.ok(thrown instanceof Error, "respond() threw");
  assert.match(thrown.message, /doesn't declare .*: \$\.scorerInternalNote\./);
  assert.equal(status, 500);
  assert.deepEqual(body, HOUSE_500);
});

test("an app with no env (a unit test's) refuses the undeclared field too", async () => {
  const { status, thrown } = await call("/answer", undefined);
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /\$\.scorerInternalNote/);
  assert.equal(status, 500);
});

test("development names every undeclared field, in nested objects and inside arrays", async () => {
  const { status, thrown } = await call("/nested", "development");
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /: \$\.team\.secret, \$\.members\[1\]\.email\./);
  assert.equal(status, 500);
});

test("production strips the nested undeclared fields and answers", async () => {
  const { status, body } = await call("/nested", "production");
  assert.equal(status, 200);
  assert.deepEqual(body, { team: { id: "team_a" }, members: [{ login: "rj-a" }, { login: "rj-b" }], scores: { top1: 0.5 }, at: new Date(0).toISOString() });
});

test("development answers when every field is declared, a record's keys and undefined values included", async () => {
  const declared = await call("/declared", "development");
  assert.equal(declared.thrown, undefined);
  assert.equal(declared.status, 200);
  assert.deepEqual(declared.body, { teamId: "team_a", note: "only what the schema names" });
  const nested = await call("/clean-nested", "development");
  assert.equal(nested.thrown, undefined);
  assert.equal(nested.status, 200);
  assert.deepEqual(nested.body.scores, { top1: 0.5, top5: 0.9 });
});

test("an answer that fails its schema is the house 500 in production, carrying nothing from the object", async () => {
  const { status, body } = await call("/broken", "production");
  assert.deepEqual(body, HOUSE_500);
  assert.equal(status, 500);
});

test("an answer that fails its schema refuses loudly in development too", async () => {
  const { status, body } = await call("/broken", "development");
  assert.equal(status, 500);
  assert.deepEqual(body, HOUSE_500);
});
