import { env } from "./cli.ts";
import { readStackInfo, type StackInfo } from "./stack-info.ts";

/**
 * The portal's HTTP API as the SPA and the CLI see it. Node fetch with a
 * cookie jar, because several journeys drive the same session that the
 * browser approves from — development sign-in, cohort join, device approval,
 * and the reads that verify what a CLI actually wrote.
 */
export class Portal {
  private cookies = new Map<string, string>();

  private constructor(
    readonly info: StackInfo,
    private readonly origin: string,
  ) {}

  /**
   * A client through the shaper front (the browsable origin). The shaper is
   * transparent between faults, and its front is the only HTTP-reachable face
   * of the Worker — the canonical portal.journey.test hostname never resolves
   * from Node, by design. State-setting calls therefore take the same road a
   * browser does.
   */
  static async create(): Promise<Portal> {
    const info = await readStackInfo();
    return new Portal(info, info.browsableOrigin);
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const [pair] = line.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  async request(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string; json: () => unknown }> {
    const response = await fetch(new URL(path, this.origin), {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    this.absorbCookies(response);
    const body = await response.text();
    return { status: response.status, body, json: () => JSON.parse(body) };
  }

  /** Development sign-in, which only exists because the stack has no OAuth. */
  async devLogin(login: string, options: { demo?: boolean } = {}): Promise<number> {
    const response = await this.request("/api/dev/login", {
      method: "POST",
      body: { login, ...(options.demo ? { demo: true } : {}) },
    });
    return response.status;
  }

  /** Joins the seeded cohort with its join code. */
  async joinCohort(code: string): Promise<number> {
    const response = await this.request("/api/cohorts/join", {
      method: "POST",
      body: { code },
    });
    return response.status;
  }

  /** The current session, to read team and role state after a join. */
  async session(): Promise<{ status: number; body: string; json: () => any }> {
    return this.request("/api/session");
  }

  /** The signed-in student's registered CLI devices. */
  async cliDevices(): Promise<Array<{ id: string; name: string; createdAt: number }>> {
    const response = await this.request("/api/v1/connections");
    const parsed = response.json() as { cliDevices: Array<{ id: string; name: string; createdAt: number }> };
    return parsed.cliDevices ?? [];
  }

  /** Approves a printed device code as the signed-in student. */
  async approveDevice(userCode: string, deviceName: string): Promise<number> {
    const response = await this.request("/api/v1/cli/device/approve", {
      method: "POST",
      body: { userCode, deviceName },
    });
    return response.status;
  }

  /** Revokes one of the signed-in student's devices; the CLI's token dies with it. */
  async revokeDevice(deviceId: string): Promise<number> {
    const response = await this.request("/api/v1/cli/devices", {
      method: "DELETE",
      body: { deviceId },
    });
    return response.status;
  }

  /** The signed-in student's reports for benchmarks with no active version. */
  async teamUntrackedReports(): Promise<any[]> {
    const response = await this.request("/api/v1/local-reports?untracked=1");
    if (response.status !== 200) throw new Error(`local-reports answered ${response.status}: ${response.body}`);
    return parseReportList(response.json());
  }

  /** The team's local reports for one benchmark, seen through session auth. */
  async teamLocalReports(benchmarkId: string): Promise<any[]> {
    const response = await this.request(`/api/v1/local-reports?benchmark=${encodeURIComponent(benchmarkId)}`);
    if (response.status !== 200) throw new Error(`local-reports answered ${response.status}: ${response.body}`);
    return parseReportList(response.json());
  }

  /** The signed-in user's connection summary (ConnectionSummarySchema):
   * `discord` is null until a link token is confirmed. */
  async connectionSummary(): Promise<ConnectionSummary> {
    const response = await this.request("/api/v1/connections");
    if (response.status !== 200) throw new Error(`connections answered ${response.status}: ${response.body}`);
    const parsed = response.json() as Partial<ConnectionSummary>;
    if (typeof parsed !== "object" || parsed === null || !("discord" in parsed)) {
      throw new Error(`connections answered an unrecognized shape: ${response.body.slice(0, 200)}`);
    }
    return parsed as ConnectionSummary;
  }

  /** Confirms a Discord link token minted by the bot's /cog link start,
   * through this session's team auth. Answers the updated summary. */
  async confirmDiscordLink(token: string): Promise<ConnectionSummary> {
    const response = await this.request("/api/v1/connections/discord/confirm", {
      method: "POST",
      body: { token },
    });
    if (response.status !== 200) throw new Error(`discord link confirm answered ${response.status}: ${response.body}`);
    return response.json() as ConnectionSummary;
  }

  /** Revokes this session's Discord link, so a later journey linking the same
   * portal user does not hit the link_conflict the adversarial journey saw. */
  async revokeDiscordLink(): Promise<ConnectionSummary> {
    const response = await this.request("/api/v1/connections/discord", { method: "DELETE" });
    if (response.status !== 200) throw new Error(`discord link revoke answered ${response.status}: ${response.body}`);
    return response.json() as ConnectionSummary;
  }

  /** The team's run surfaces. Mounted at /api/run-surfaces (not under v1)
   * and answering a bare array of RunSurfaceSnapshotSchema. */
  async teamRunSurfaces(): Promise<any[]> {
    const response = await this.request("/api/run-surfaces");
    if (response.status !== 200) throw new Error(`run-surfaces answered ${response.status}: ${response.body}`);
    return parseSurfaceList(response.json());
  }
}

/** The list endpoints answer with a bare array (LocalReportListSchema is
 *  z.array(LocalReportSchema)). An object with a `reports` key also passes so
 *  a future envelope cannot silently read as empty again - anything else
 *  throws, because an unreadable shape once hid real reports behind `?? []`
 *  and every listing case read zero through runs 11 and 12. */
function parseReportList(parsed: unknown): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { reports?: unknown }).reports)) {
    return (parsed as { reports: any[] }).reports;
  }
  throw new Error(`local-reports answered an unrecognized shape: ${JSON.stringify(parsed).slice(0, 200)}`);
}

/** Same contract as parseReportList for the run-surfaces list
 *  (RunSurfaceSnapshotSchema as a bare array). */
function parseSurfaceList(parsed: unknown): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { surfaces?: unknown }).surfaces)) {
    return (parsed as { surfaces: any[] }).surfaces;
  }
  throw new Error(`run-surfaces answered an unrecognized shape: ${JSON.stringify(parsed).slice(0, 200)}`);
}

/** The setup page's check-off secret, which mints the page's copyable commands. */
export function betterAuthSecret(): string {
  return env("BETTER_AUTH_SECRET");
}

/** The /api/v1/connections summary (ConnectionSummarySchema in
 *  packages/contracts): the Discord link is null until confirmed. */
export interface ConnectionSummary {
  github: { id: number | null; login: string; avatarUrl: string | null } | null;
  discord: { userId: string; username: string; linkedAt: number } | null;
}
