import type { Browser } from '@e2e-dev/web';

// Account-state calls a test makes as whoever the browser is signed in as.
// The browser's own fetch carries the session cookie, as the app's does.

/** Joins the cohort whose join code this is (the local seed's is VISION26). */
export function joinCohort(browser: Browser, code: string): Promise<number> {
  return browser.evaluate(
    (joinCode: string) =>
      fetch('/api/cohorts/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: joinCode }),
      }).then((response) => response.status),
    code,
  );
}

export type SessionState = { cohort: string | null; team: { id: string; name: string } | null };

/** The signed-in account's cohort slug and team, as /api/session reports them. */
export function sessionState(browser: Browser): Promise<SessionState> {
  return browser.evaluate(() =>
    fetch('/api/session')
      .then((response) => response.json())
      .then((session: { cohort: { slug: string } | null; team: { id: string; name: string } | null }) => ({
        cohort: session.cohort?.slug ?? null,
        team: session.team ? { id: session.team.id, name: session.team.name } : null,
      })),
  );
}

/** Leaves one team as the signed-in account; the route removes only that account's own membership. */
export function leaveTeam(browser: Browser, teamId: string): Promise<number> {
  return browser.evaluate(
    (id: string) =>
      fetch('/api/team/leave', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: id }),
      }).then((response) => response.status),
    teamId,
  );
}

export type PendingCode = { valid: boolean; approved: boolean };

/** Whether a printed device code is still open and whether anyone approved it, without approving it. */
export function pendingCode(browser: Browser, userCode: string): Promise<PendingCode> {
  return browser.evaluate(
    (code: string) =>
      fetch(`/api/v1/cli/device/status?user_code=${encodeURIComponent(code)}`)
        .then((response) => response.json())
        .then((status: { valid: boolean; approved: boolean }) => ({ valid: status.valid, approved: status.approved })),
    userCode,
  );
}
