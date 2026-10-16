// Pure support helpers for the burst11-student journey walker, kept free of
// side effects so the regression tests can import them
// (`node --test tools/portal-real-journeys/journeys/burst11-student/`).
//
// Doubles contract (matching the real-journeys harness's stack/doubles.mjs):
// the provider doubles answer on the DOUBLES_BASE origin itself (github-rest)
// and at base-port +2 (discord) and +3 (modal-runner), each journalling at
// GET /__doubles/journal.

export const DEFAULT_DOUBLES_BASE = "http://127.0.0.1:8811";

const JOURNAL_PATH = "/__doubles/journal";

/** Port offsets from DOUBLES_BASE to each provider double, harness order. */
const DOUBLE_OFFSETS = [
  ["github-rest", 0],
  ["discord", 2],
  ["modal-runner", 3],
];

/**
 * Resolve the configured DOUBLES_BASE into per-double journal URLs.
 * Unset/empty falls back to the documented default; the sentinel `off`
 * returns null so callers skip the no-outbound-traffic check explicitly.
 * Returns null, or [{ name, journal }] in harness order.
 */
export function doublesJournals(raw) {
  const configured = typeof raw === "string" ? raw.trim() : "";
  if (configured.toLowerCase() === "off") return null;
  let base;
  try {
    base = new URL(configured === "" ? DEFAULT_DOUBLES_BASE : configured);
  } catch {
    throw new Error(`DOUBLES_BASE is not a URL: ${JSON.stringify(raw)} (use e.g. ${DEFAULT_DOUBLES_BASE}, or "off" to skip the journal check)`);
  }
  const port = Number(base.port) || (base.protocol === "https:" ? 443 : 80);
  return DOUBLE_OFFSETS.map(([name, offset]) => {
    const origin = `${base.protocol}//${base.hostname}:${port + offset}`;
    return { name, journal: `${origin}${JOURNAL_PATH}` };
  });
}

/**
 * Poll an async fetchRuns() until predicate matches a run, instead of
 * sleeping a fixed delay and trusting one fetch. Throws naming `label`
 * (with the last response body) when the deadline passes first.
 */
export async function pollForRuns(fetchRuns, predicate, { deadlineMs = 30_000, intervalMs = 500, label = "the new run" } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const runs = await fetchRuns();
    const found = Array.isArray(runs) ? runs.find(predicate) : undefined;
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `${label} never appeared in the runs list within ${deadlineMs}ms; last body: ${JSON.stringify(runs).slice(0, 300)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
