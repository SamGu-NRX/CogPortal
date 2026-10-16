import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { egressInfo, placeEgressMarker, readEgressEvents, type EgressEvent } from "../support/egress.ts";
import { windowEvents } from "../support/egress-policy.ts";

/**
 * Shared machinery for the week 2/3 public-data journeys. The contract under
 * test: the CLI's first real-data run downloads the documented public assets
 * (witnessed, recorded in the receipt) and everything else stays loopback —
 * any other Portal or provider traffic from an offline command is a defect.
 */
const run = promisify(execFile);

export const PIN_ID = require_env("PIN_ID");
export const PIN_REV = require_env("PIN_REV");
export const PIN_SOURCE = require_env("PIN_SOURCE");
export const VENV_BIN = require_env("VENV_MATRIX");
export const JOURNEY_HOME = require_env("JOURNEY_HOME");

export const COGWORKS = `${VENV_BIN}/cogworks`;

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`required environment variable ${name} is not set`);
  return value;
}

/** Asserts the journey home is empty: the first-real-run contract needs cold
 * caches, and a pre-seeded cache would hide exactly the fetches we witness. */
export async function assertJourneyHomeCold(): Promise<void> {
  const entries = await readdir(JOURNEY_HOME).catch(() => null);
  if (entries === null) throw new Error(`journey home ${JOURNEY_HOME} does not exist`);
  if (entries.length > 0) {
    throw new Error(`journey home ${JOURNEY_HOME} is not empty: ${entries.slice(0, 8).join(", ")}`);
  }
}

/** Runs a real CLI command in the team repository under a fresh journey home,
 * routed through the egress witness. Never throws on nonzero exit — callers
 * judge the outcome — but records stdout/stderr for the receipt. */
export async function runCogworks(
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ exit: number; output: string }> {
  const { proxy } = egressInfo();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: JOURNEY_HOME,
    http_proxy: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: "localhost,127.0.0.1",
    // The journeys run against the team repository only; the CLI must never
    // inherit a portal URL from the operator's shell.
    COGBENCH_PORTAL: "",
    PORTAL_URL: "",
  };
  try {
    const { stdout, stderr } = await run(COGWORKS, args, {
      cwd: options.cwd,
      env: environment,
      timeout: options.timeoutMs ?? 1_800_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exit: 0, output: `${stdout}\n${stderr}`.trim() };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
    return { exit: err.code ?? -1, output };
  }
}

/** The witness's events for the window opened at the marker: requests made
 * after it and their follow-ups, without mode flips (support/egress-policy.ts
 * windowEvents). */
export async function cliTraffic(after: number): Promise<EgressEvent[]> {
  return windowEvents(await readEgressEvents(after), after);
}

export { assertOnlineEgress, trafficSummary, undocumentedHosts, zeroRequestViolation } from "../support/egress-policy.ts";

export interface ParsedJsonReport {
  exit: number;
  report: Record<string, any> | null;
  output: string;
}

/** Parses a `--json` CLI report out of a run's output. */
export function parseReport(result: { exit: number; output: string }): ParsedJsonReport {
  const start = result.output.indexOf("{");
  const end = result.output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { exit: result.exit, report: null, output: result.output };
  }
  try {
    return { exit: result.exit, report: JSON.parse(result.output.slice(start, end + 1)), output: result.output };
  } catch {
    return { exit: result.exit, report: null, output: result.output };
  }
}

export { placeEgressMarker };
