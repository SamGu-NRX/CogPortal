import type { Context } from "hono";
import type { AppEnv } from "../env";
import { readBodyText } from "./respond";

/** Give Better Auth a bounded, fresh request without changing its body parser. */
export async function boundedAuthRequest(c: Context<AppEnv>): Promise<Request> {
  const raw = c.req.raw;
  if (raw.method === "GET" || raw.method === "HEAD") return raw;
  const body = await readBodyText(c, "auth");
  const headers = new Headers(raw.headers);
  headers.delete("Content-Length");
  return new Request(raw.url, { method: raw.method, headers, body, duplex: "half" } as RequestInit);
}
