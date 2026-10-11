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

/** A route must refuse: any 4xx. A 5xx is a failure to handle, not a refusal. */
export function refused(name: string, status: number, body: string): Check {
  const ok = status >= 400 && status < 500;
  return { name, ok, detail: ok ? `HTTP ${status}` : `HTTP ${status}: ${body.slice(0, 140)}` };
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
