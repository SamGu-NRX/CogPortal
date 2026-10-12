/**
 * Journey framework: check/result types, refusal + equality helpers, the
 * fresh-stack lifecycle wrapper, and report assembly.
 */
export type Check = { name: string; ok: boolean; detail?: string };

export type JourneyResult = {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  fixedInput: string;
  checks: Check[];
  skippedBecause?: string;
  ms: number;
};

export type Stack = {
  baseUrl: string;
  port: number;
  root: string; // repo root
  log: (line: string) => void;
  teardown: () => Promise<void>;
};

export type Journey = {
  id: string;
  title: string;
  /** The immutable input the journey fixes before it measures. */
  fixedInput: string;
  needsStack: boolean;
  run(stack: Stack, log: (line: string) => void): Promise<Check[]>;
};

/** The exact refusal a guarded route must answer with. */
export type Refusal = { status?: number; code?: string };

/** The API-level 404 body for paths no registrar claims — not an authorization refusal. */
const ROUTE_NOT_FOUND = "API route not found.";

function bodyErrorCode(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * A route must refuse.
 *
 * With an expectation, the status AND the body error code must match exactly:
 * a 404 from a missing object proves nothing about the guard, and neither
 * does a 404 from a path no registrar claims. Without one (journeys that
 * predate exact expectations keep the three-argument call) the baseline stays
 * a 4xx that is not the API-level route-not-found error. A 5xx is a failure
 * to handle, not a refusal, either way.
 */
export function refused(name: string, status: number, body: string, expected?: Refusal): Check {
  const misses: string[] = [];
  let ok = status >= 400 && status < 500;
  if (status === 404 && body.includes(ROUTE_NOT_FOUND)) {
    ok = false;
    misses.push("route does not exist (probe targets a path no registrar claims)");
  }
  if (expected?.status !== undefined) {
    const statusOk = status === expected.status;
    ok = ok && statusOk;
    if (!statusOk) misses.push(`status ${status}, expected ${expected.status}`);
  }
  if (expected?.code !== undefined) {
    const code = bodyErrorCode(body);
    const codeOk = code === expected.code;
    ok = ok && codeOk;
    if (!codeOk) misses.push(`code ${code ?? "<none>"}, expected ${expected.code}`);
  }
  return {
    name,
    ok,
    detail: ok ? `HTTP ${status}` : `HTTP ${status}: ${misses.join("; ") || body.slice(0, 140)}`,
  };
}

/**
 * The positive control: the legitimate holder of the credential the guard
 * demands performs the identical request and must succeed. Without this, an
 * over-broad guard that refuses everyone would pass refused().
 */
export function allowed(name: string, status: number, body: string, want: number | number[] = 200): Check {
  const wanted = Array.isArray(want) ? want : [want];
  const ok = wanted.includes(status);
  return {
    name,
    ok,
    detail: ok ? `HTTP ${status}` : `HTTP ${status}: ${body.slice(0, 140)} — wanted ${wanted.join(" or ")}`,
  };
}

export function assertEq(actual: unknown, expected: unknown, name: string, detail = ""): Check {
  const ok = actual === expected;
  return { name: `${name} — expected ${String(expected)}, got ${String(actual)}${detail ? ` (${detail})` : ""}`, ok };
}

export class SkipJourney extends Error {}

/**
 * Fresh-stack wrapper: boots an isolated local stack, runs the journey,
 * tears everything down. A journey that cannot get its stack throws
 * SkipJourney, which run-all turns into status=skip with the reason —
 * never a fabricated pass.
 */
export async function withStack(
  journeyId: string,
  log: (line: string) => void,
  fn: (stack: Stack) => Promise<Check[]>,
): Promise<Check[]> {
  const { bootStack } = await import("./stack.mts");
  const stack = await bootStack(journeyId, log);
  try {
    return await fn(stack);
  } finally {
    await stack.teardown();
  }
}

export function summarize(results: JourneyResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    lines.push(
      `[${r.status.toUpperCase()}] ${r.id} — ${r.checks.length} checks` +
        (bad.length ? `, ${bad.length} failed` : "") +
        (r.skippedBecause ? ` (skip: ${r.skippedBecause})` : ""),
    );
    for (const c of bad) lines.push(`    FAIL ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  return lines.join("\n");
}
