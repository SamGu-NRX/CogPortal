import type { Context } from "hono";
import type { AppEnv } from "../env";
import { readBodyBytes } from "./respond";

/** Give Better Auth a bounded, fresh request without changing its body parser. */
export async function boundedAuthRequest(c: Context<AppEnv>): Promise<Request> {
  const raw = c.req.raw;
  if (raw.method === "GET" || raw.method === "HEAD") return raw;
  const hadBody = raw.body !== null;
  const body = await readBodyBytes(c, "auth");
  if (!hadBody) return raw;
  return new Request(raw.url, { method: raw.method, headers: new Headers(raw.headers), body, duplex: "half" } as RequestInit);
}
