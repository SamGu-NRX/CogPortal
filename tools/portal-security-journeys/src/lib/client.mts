/**
 * HTTP client with a minimal cookie jar, plus the student-identity factory
 * and run polling helpers used by every journey.
 */
import { createHash } from "node:crypto";

export type ApiResponse = {
  status: number;
  text: string;
  headers: Headers;
  json(): any;
};

export class Api {
  private cookies = new Map<string, string>();
  constructor(public baseUrl: string) {}

  storeCookies(res: Response) {
    const raw: string[] =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
    for (const c of raw) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async req(
    method: string,
    path: string,
    opts: { json?: unknown; headers?: Record<string, string>; anonymous?: boolean } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (!opts.anonymous && this.cookies.size && !("cookie" in headers)) headers["cookie"] = this.cookieHeader();
    let body: string | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, redirect: "manual" });
    this.storeCookies(res);
    const text = await res.text();
    return {
      status: res.status,
      text,
      headers: res.headers,
      json: () => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
    };
  }
}

export const DEV_PASSWORD = "cogportal-local-dev-password";
export const JOIN_CODE = "VISION26";
export const FIXTURE_REPO = "cogworks-demo/face-finder";

export type Student = { api: Api; login: string; teamName: string };

/**
 * A student identity: dev login (local-only), cohort join (409 tolerated as
 * already-joined), then a fixture-repo team connection. Throws if login
 * fails — everything downstream depends on a real session cookie.
 */
export async function newStudent(stack: { baseUrl: string }, login: string, opts: { teamName: string }): Promise<Student> {
  const api = new Api(stack.baseUrl);
  const loginRes = await api.req("POST", "/api/dev/login", { json: { login, demo: true, password: DEV_PASSWORD } });
  if (loginRes.status !== 200 && loginRes.status !== 201) {
    throw new Error(`dev login failed for ${login}: ${loginRes.status} ${loginRes.text.slice(0, 200)}`);
  }
  const join = await api.req("POST", "/api/cohorts/join", { json: { joinCode: JOIN_CODE } });
  if (![200, 201, 409].includes(join.status)) {
    throw new Error(`cohort join failed for ${login}: ${join.status} ${join.text.slice(0, 200)}`);
  }
  const connect = await api.req("POST", "/api/github/connect", { json: { fullName: FIXTURE_REPO, teamName: opts.teamName } });
  if (connect.status !== 200 && connect.status !== 201) {
    throw new Error(`github connect failed for ${login}: ${connect.status} ${connect.text.slice(0, 200)}`);
  }
  return { api, login, teamName: opts.teamName };
}

const TERMINAL_BAD = new Set(["failed", "canceled", "cancelled", "errored"]);

/** Poll a run until it reaches the wanted status (or dies trying). */
export async function waitForRunStatus(api: Api, runId: string, want: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api.req("GET", `/api/runs/${runId}`);
    if (res.status === 200) {
      const status = res.json()?.status;
      if (status === want) return status;
      if (typeof status === "string" && TERMINAL_BAD.has(status)) throw new Error(`run ${runId} ended ${status}, wanted ${want}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`run ${runId} never reached ${want}`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
