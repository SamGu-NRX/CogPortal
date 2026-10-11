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
    const parsed = response.json() as { reports?: any[] };
    return parsed.reports ?? [];
  }

  /** The team's local reports for one benchmark, seen through session auth. */
  async teamLocalReports(benchmarkId: string): Promise<any[]> {
    const response = await this.request(`/api/v1/local-reports?benchmark=${encodeURIComponent(benchmarkId)}`);
    if (response.status !== 200) throw new Error(`local-reports answered ${response.status}: ${response.body}`);
    const parsed = response.json() as { reports?: any[] };
    return parsed.reports ?? [];
  }
}

/** The setup page's check-off secret, which mints the page's copyable commands. */
export function betterAuthSecret(): string {
  return env("BETTER_AUTH_SECRET");
}
