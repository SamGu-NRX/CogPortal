import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { schema } from "./schema";

function buildClient(env: Env) {
  return drizzle(env.DB, { schema });
}

/**
 * One Drizzle client per D1 binding, reused for the life of the isolate.
 *
 * `getDb` is called from 106 places, several of them on a single request, and
 * every call rebuilt a client out of the same binding and the same `schema`
 * module constant. Building it once removes that repeated construction. What a
 * profile of it does and does not show is in the pull request.
 *
 * Sharing is safe because the client keeps no per-query state: the session
 * holds only `client`, `schema` and `options`, prepares a fresh statement per
 * call, and leaves drizzle's cache at its NoopCache default
 * (`drizzle-orm/d1/session.js`). Keyed on the binding so another environment,
 * or a Durable Object with its own `env`, gets its own client, and weak so it
 * lives no longer than the binding does.
 */
const clients = new WeakMap<Env["DB"], ReturnType<typeof buildClient>>();

export function getDb(env: Env) {
  const existing = clients.get(env.DB);
  if (existing) return existing;
  const client = buildClient(env);
  clients.set(env.DB, client);
  return client;
}

export type Database = ReturnType<typeof getDb>;
