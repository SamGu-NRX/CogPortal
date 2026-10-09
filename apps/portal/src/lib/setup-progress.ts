import { useCallback, useState } from "react";

/**
 * Self-check state for the setup guide. The portal verifies what it can see
 * (a connected fork, a linked device, a synced report); everything that
 * happens only on the student's machine is theirs to tick off. Stored per
 * team + login so a shared computer doesn't leak progress between students.
 */
function checksKey(teamId: string, login: string): string {
  return `cog-setup:${teamId}:${login}`;
}

function dismissKey(teamId: string, login: string): string {
  return `cog-setup-dismissed:${teamId}:${login}`;
}

export function clearSetupProgress(teamId: string, login: string): void {
  try {
    localStorage.removeItem(checksKey(teamId, login));
    localStorage.removeItem(dismissKey(teamId, login));
  } catch {
    /* private mode — there may be nothing durable to clear */
  }
}

/**
 * Parse a stored check-off payload. The portal wrote this value itself, but a
 * shared computer can hold anything: an older format, a manual edit, truncated
 * text. Anything that is not a JSON array of strings reads as no checks, so a
 * broken payload costs a student their ticks, never the setup guide.
 */
export function parseChecks(raw: string | null): ReadonlySet<string> {
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const values: unknown[] = parsed;
  return new Set(values.filter((v): v is string => typeof v === "string"));
}

function readChecksByKey(key: string): ReadonlySet<string> {
  try {
    return parseChecks(localStorage.getItem(key));
  } catch {
    return new Set();
  }
}

/**
 * Check-off state tagged with the storage key it came from, so the hook can
 * notice when that key moved on.
 */
export type ChecksCache = {
  readonly key: string;
  readonly checks: ReadonlySet<string>;
};

/**
 * Keep the cached checks only while they belong to the current storage key.
 * When the key changes (the setup guide can stay mounted while the student
 * switches teams in another tab), read the new slot instead of showing the
 * previous team's ticks. `read` is injected so this stays testable without a
 * DOM.
 */
export function reconcileChecks(
  cache: ChecksCache,
  key: string,
  read: (storageKey: string) => ReadonlySet<string>,
): ChecksCache {
  return cache.key === key ? cache : { key, checks: read(key) };
}

export function useSetupChecks(
  teamId: string,
  login: string,
): [ReadonlySet<string>, (stepId: string) => void] {
  const key = checksKey(teamId, login);
  const [cache, setCache] = useState<ChecksCache>(() => ({
    key,
    checks: readChecksByKey(key),
  }));
  // Adjust state during render (not in an effect) so the first paint after a
  // team or login change already reads the right storage slot.
  const current = reconcileChecks(cache, key, readChecksByKey);
  if (current !== cache) {
    setCache(current);
  }
  const toggle = useCallback(
    (stepId: string) => {
      setCache((prev) => {
        const base = reconcileChecks(prev, key, readChecksByKey);
        const next = new Set(base.checks);
        if (next.has(stepId)) next.delete(stepId);
        else next.add(stepId);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          /* private mode — session-only progress is fine */
        }
        return { key, checks: next };
      });
    },
    [key],
  );
  return [current.checks, toggle];
}

export function isSetupDismissed(teamId: string, login: string): boolean {
  try {
    return localStorage.getItem(dismissKey(teamId, login)) === "1";
  } catch {
    return false;
  }
}

export function dismissSetup(teamId: string, login: string): void {
  try {
    localStorage.setItem(dismissKey(teamId, login), "1");
  } catch {
    /* ignore */
  }
}

export type SetupEntry = "created" | "joined";

/**
 * Shared with the dashboard nudge: how far along the guide is. The optional
 * device-link step never counts toward the total — nobody should sit at
 * "5 of 6" for skipping an optional step. Verified steps also accept a
 * self-check so a solo or offline student is never structurally stuck.
 */
export function setupSteps(
  entry: SetupEntry,
  checks: ReadonlySet<string>,
  verified: {
    teammates: boolean;
    /** Steps confirmed via the terminal one-liner (server-verified). */
    terminal?: readonly string[];
  },
): { done: number; total: number } {
  const terminal = new Set(verified.terminal ?? []);
  // Ignore legacy browser checkboxes; only CLI evidence counts machine steps.
  const verifiedByCli = (step: string) => terminal.has(step);
  const states = [
    true, // fork connected / team joined — always true once a team exists
    entry === "created"
      ? verified.teammates || checks.has("teammates")
      : true,
    verifiedByCli("clone"),
    verifiedByCli("environment"),
    verifiedByCli("project"),
    verifiedByCli("wiring"),
  ];
  return { done: states.filter(Boolean).length, total: states.length };
}

export function setupProgress(
  teamId: string,
  login: string,
  entry: SetupEntry,
  verified: { teammates: boolean; terminal?: readonly string[] },
): { done: number; total: number } {
  return setupSteps(entry, readChecksByKey(checksKey(teamId, login)), verified);
}
