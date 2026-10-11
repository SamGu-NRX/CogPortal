// Shared journey helpers.
//
// The contract every helper keeps: nothing under test is stubbed. Sessions
// are minted through the Worker's own dev-auth POST (a real route that
// requires the development configuration); state is read back through real
// APIs; shaping happens on the wire via the stack proxy.

const STACK = "http://127.0.0.1:8810";

/** Announces the journey: a fresh D1, freshly built SPA, fresh Worker. */
export async function freshJourney(name, { profile = "fixture" } = {}) {
  const response = await fetch(`${STACK}/__control/fresh`, {
    method: "POST",
    body: JSON.stringify({ nextProfile: profile }),
  });
  if (!response.ok) throw new Error(`fresh boot failed for ${name}: ${await response.text()}`);
}

/** REST helpers for the stack supervisor's control plane. */
export const control = {
  clearFaults: () => fetch(`${STACK}/__proxy/faults/clear`, { method: "POST" }),
  fault: (rule) =>
    fetch(`${STACK}/__proxy/faults`, { method: "POST", body: JSON.stringify({ rules: [rule] }) }),
  restartWorker: () => fetch(`${STACK}/__control/restart-worker`, { method: "POST" }),
  prodBoot: () => fetch(`${STACK}/__control/prod-boot`, { method: "POST" }),
  devBoot: () => fetch(`${STACK}/__control/dev-boot`, { method: "POST" }),
  sql: async (sql) => {
    const response = await fetch(`${STACK}/__control/sql`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`sql failed: ${payload.error}`);
    return payload.output;
  },
};

/**
 * Signs a test user in through the Worker's real dev-auth route. The
 * response's session cookies land on the shared request context, so the
 * SPA's own fetches carry them.
 */
export async function signIn(page, login, { demo = true } = {}) {
  const response = await page.request.post(`${STACK}/api/dev/login`, {
    data: { login, demo },
  });
  if (!response.ok()) {
    throw new Error(`dev login failed for ${login}: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

export const TEAM = {
  name: "parity-checkers",
  repo: "cogworks-demo/face-finder",
  channel: "111222333444555666",
};
