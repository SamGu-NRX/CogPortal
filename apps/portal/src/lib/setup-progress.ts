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

function readChecks(teamId: string, login: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(checksKey(teamId, login));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function useSetupChecks(
  teamId: string,
  login: string,
): [ReadonlySet<string>, (stepId: string) => void] {
  const [checks, setChecks] = useState<ReadonlySet<string>>(() =>
    readChecks(teamId, login),
  );
  const toggle = useCallback(
    (stepId: string) => {
      setChecks((prev) => {
        const next = new Set(prev);
        if (next.has(stepId)) next.delete(stepId);
        else next.add(stepId);
        try {
          localStorage.setItem(checksKey(teamId, login), JSON.stringify([...next]));
        } catch {
          /* private mode — session-only progress is fine */
        }
        return next;
      });
    },
    [teamId, login],
  );
  return [checks, toggle];
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
  return setupSteps(entry, readChecks(teamId, login), verified);
}
