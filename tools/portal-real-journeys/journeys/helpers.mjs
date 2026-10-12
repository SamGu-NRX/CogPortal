// Shared journey helpers.
//
// Nothing under test is stubbed. Sessions come from the Worker's own dev-auth
// route (which exists only in the development configuration); state is read
// back through real routes or the run's own D1; faults happen on the wire, at
// the shaping proxy (browser to Worker) or at a hop (Worker to provider).

import { expect } from "@playwright/test";
import { DOUBLE_PORTS, HOP_PORTS } from "../stack/doubles.mjs";

export const STACK = "http://127.0.0.1:8810";
/** The Activity's host in a run: same proxy, its own host name and cookies. */
export const ACTIVITY = "http://localhost:8810";

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/** A fresh D1 (migrations + seed) and a Worker in `profile`, doubles and hops reset. */
export async function fresh(profile = "fixture") {
  await post(`${STACK}/__proxy/faults/clear`);
  for (const port of Object.values(DOUBLE_PORTS)) await post(`http://127.0.0.1:${port}/__doubles/reset`);
  for (const port of Object.values(HOP_PORTS)) await post(`http://127.0.0.1:${port}/__hop/reset`);
  return post(`${STACK}/__control/fresh`, { profile });
}

export const control = {
  /** Browser-to-Worker rule; see stack.mjs for the vocabulary. */
  fault: (rule) => post(`${STACK}/__proxy/faults`, { rules: [rule] }),
  clearFaults: () => post(`${STACK}/__proxy/faults/clear`),
  /** Answers a holdAnswer rule is keeping from the browser: [{ tag, method, path, status }]. */
  held: async () => (await (await fetch(`${STACK}/__proxy/held`)).json()).held,
  release: (tag) => post(`${STACK}/__proxy/release`, { tag }),
  restartWorker: () => post(`${STACK}/__control/restart-worker`),
  /** Rows of the last statement, read from the run's own D1. */
  sql: async (sql) => (await post(`${STACK}/__control/sql`, { sql })).rows,
  /** Every row of every table in the run's D1: { table: rows }. */
  snapshot: async () => (await post(`${STACK}/__control/snapshot`)).tables,
};

export const doubles = {
  journal: async (double) => {
    const response = await fetch(`http://127.0.0.1:${DOUBLE_PORTS[double]}/__doubles/journal`);
    return (await response.json()).journal;
  },
  /** A Worker-to-provider rule on the hop in front of `double`. */
  hopRule: (double, rule) => post(`http://127.0.0.1:${HOP_PORTS[double]}/__hop/rules`, rule),
  discordCode: (code, user) => post(`http://127.0.0.1:${DOUBLE_PORTS.discord}/__doubles/discord/codes`, { code, user }),
};

/**
 * Signs in through the Worker's dev-auth route on the page's own context, so
 * the SPA's requests carry the session. `demo` provisions the seeded cohort
 * and the fixture repository's demo team through the real connect path.
 */
export async function signIn(page, login, { demo = false } = {}) {
  const response = await page.request.post(`${STACK}/api/dev/login`, { data: { login, demo } });
  expect(response.ok(), `dev login for ${login}: ${response.status()}`).toBeTruthy();
  return response.json();
}

/**
 * How the two policy matrices (s5-route-matrix, s5-page-matrix) run, recorded
 * on the test as a `matrix-mode` annotation so a receipt can show it.
 * "enforce" compares every cell with the policy. "observe"
 * (RJ_MATRIX_OBSERVE=1) records what the Worker answers, for rewriting the
 * policy after a route changes, and then fails the test: a run that checked
 * nothing must never read as a pass. Under the acceptance runner
 * (RJ_ACCEPTANCE=1) observe mode is refused before anything runs.
 */
export function matrixMode(testInfo) {
  const mode = process.env.RJ_MATRIX_OBSERVE ? "observe" : "enforce";
  if (mode === "observe" && process.env.RJ_ACCEPTANCE) {
    throw new Error("RJ_MATRIX_OBSERVE is set under the acceptance runner; refusing to record instead of checking the policy");
  }
  testInfo.annotations.push({ type: "matrix-mode", description: mode });
  return mode;
}

/** Ends an observe-mode matrix run: what was recorded is written, and the test fails. */
export function failObserved(out) {
  throw new Error(`observe mode (RJ_MATRIX_OBSERVE) recorded the answers to ${out} and did not check them against the policy; this run is not a pass`);
}

/** Any journey that ends must leave the Modal double untouched under the fixture provider. */
export async function expectNoDispatch() {
  expect(await doubles.journal("modalRunner"), "nothing may be dispatched to a runner").toEqual([]);
}

/** A screenshot for review: taken once every running animation has finished. */
export async function evidence(page, name) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: `test-results/evidence/${name}.png`, fullPage: true });
}
