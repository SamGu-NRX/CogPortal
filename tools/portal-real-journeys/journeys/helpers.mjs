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
  restartWorker: () => post(`${STACK}/__control/restart-worker`),
  /** Rows of the last statement, read from the run's own D1. */
  sql: async (sql) => (await post(`${STACK}/__control/sql`, { sql })).rows,
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

/** Any journey that ends must leave the Modal double untouched under the fixture provider. */
export async function expectNoDispatch() {
  expect(await doubles.journal("modalRunner"), "nothing may be dispatched to a runner").toEqual([]);
}
