import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { schema } from "./schema";

function buildClient(env: Env) {
  return drizzle(env.DB, { schema });
}

/**
 * One Drizzle client per D1 binding, reused for the life of the isolate.
 *
 * `drizzle(binding, { schema })` walks all 32 tables in `schema` through
 * `extractTablesRelationalConfig` before it can serve a query, and the worker
 * calls `getDb` from 106 places, several of them on a single request: the
 * session lookup, the role lookup and the route body each built their own
 * client. Workers charges CPU and not the D1 waits this sits between, so that
 * repetition is the part worth removing.
 *
 * Measured on a local production build, profiled through the workerd DevTools
 * inspector over 200 authenticated `GET /api/dashboard` requests:
 * `extractTablesRelationalConfig` and `drizzle` together held 0.96 ms per
 * request of self time before this change and do not appear after it. The
 * whole-request total moved by less than the run-to-run spread (about 0.4 ms on
 * roughly 11 ms), so this buys headroom rather than a visible speed-up, and a
 * local number is not a measurement of cloud CPU margin either way.
 *
 * Sharing it is safe because the client is a function of the binding and of
 * `schema`, a module constant. Nothing about a query or a row is kept: the
 * session holds only `client`, `schema` and `options`, prepares a fresh
 * statement per call, and leaves drizzle's cache at its NoopCache default
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
