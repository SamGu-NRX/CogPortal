import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { schema } from "./schema";

function buildClient(env: Env) {
  return drizzle(env.DB, { schema });
}

/**
 * Reuse avoids rebuilding the same schema for each call. Drizzle's D1 session
 * prepares fresh statements and retains no per-query state; its result cache
 * stays at NoopCache. Binding identity keeps environments separate, and weak
 * keys let bindings be collected.
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
