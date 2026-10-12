import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import {
  egressInfo,
  placeEgressMarker,
  readEgressEvents,
  type EgressEvent,
} from "../support/egress.ts";

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

/** The documented public-asset hosts (the witness refuses everything else
 * offline; the journeys also post-check online-mode traffic against this). */
export const DOCUMENTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "codeload.github.com",
  "huggingface.co",
  "hf.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cas-bridge.xethub.hf.co",
  "cas-server.xethub.hf.co",
  "transfer.xethub.hf.co",
  "xet.hf.co",
  "www.dropbox.com",
]);
const DOCUMENTED_SUFFIXES = [".dl.dropboxusercontent.com", ".huggingface.co", ".hf.co"];

export function documentedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (DOCUMENTED_HOSTS.has(name)) return true;
  return DOCUMENTED_SUFFIXES.some((suffix) => name.endsWith(suffix));
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

/** Every request the witness saw after the marker, minus control-plane noise
 * (mode flips are logged as events but are not the CLI's traffic). */
export async function cliTraffic(after: number): Promise<EgressEvent[]> {
  const events = await readEgressEvents(after);
  return events.filter((event) => event.kind !== "mode");
}

/** The receipt line for a window of witnessed traffic: per-host request counts
 * and bytes (tunnel totals where the CLI used https, response bytes for http). */
export function trafficSummary(events: EgressEvent[]): string {
  if (events.length === 0) return "no network requests";
  const hosts = new Map<string, { requests: number; bytes: number; refused: number }>();
  for (const event of events) {
    const host = event.host ?? "(unknown)";
    const entry = hosts.get(host) ?? { requests: 0, bytes: 0, refused: 0 };
    if (event.kind === "connect" || event.kind === "http") entry.requests += 1;
    if (event.kind === "tunnel-bytes" && typeof event.received === "number") entry.bytes += event.received;
    if (event.kind === "http-response-final" && typeof event.bytes === "number") entry.bytes += event.bytes;
    if (event.allowed === false) entry.refused += 1;
    hosts.set(host, entry);
  }
  return [...hosts.entries()]
    .map(([host, s]) => `${host}: ${s.requests} requests, ${s.bytes} bytes received${s.refused ? `, ${s.refused} REFUSED` : ""}`)
    .join("; ");
}

/** Names every host in the window that the documented asset list does not
 * cover — the defect the journeys exist to catch. */
export function undocumentedHosts(events: EgressEvent[]): string[] {
  const offenders = new Set<string>();
  for (const event of events) {
    if (event.host && !documentedHost(event.host)) offenders.add(event.host);
  }
  return [...offenders].sort();
}

/**
 * Provider telemetry the online real-data runs cannot avoid without editing
 * the course CLI or its dependency pins (out of scope for the journeys).
 * Root-caused 2026-10-11: huggingface `datasets` 3.1.0 `load.py`
 * `increase_load_count()` fires `HEAD
 * https://s3.amazonaws.com/datasets.huggingface.co/datasets/datasets/<name>/<name>.py`
 * on every `load_dataset()` call to count downloads. The beacon is
 * best-effort (try/except, 3 s timeout): the offline witness refuses the
 * host and the runs still complete with filled caches, while the offline
 * `check` commands make zero requests. Every receipt still records the
 * beacon's bytes via trafficSummary — this list only keeps a root-caused
 * library beacon from permanently failing the online cases. Anything else
 * undocumented still fails the case.
 */
export const KNOWN_PROVIDER_TELEMETRY = new Set(["s3.amazonaws.com"]);

/** The undocumented hosts that are NOT the known provider telemetry above. */
export function unexplainedUndocumentedHosts(events: EgressEvent[]): string[] {
  return undocumentedHosts(events).filter((host) => !KNOWN_PROVIDER_TELEMETRY.has(host));
}

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
