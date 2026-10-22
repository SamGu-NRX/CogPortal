// The route matrix's canary scan, and the positive controls whose answers it
// reads (s5-route-matrix.journey.mjs).
//
// A positive control returns one answer, but most make several requests
// first: sign a throwaway account in, join it to the cohort, poll a run, read
// a setup token. Each of those answers came from the Worker too, and a canary
// in one of them is as much a leak as in the answer the control returns. So
// world.mjs reports every answer it receives to `heard`, and runPositives
// collects the ones that arrive while each control runs.
//
// Nothing here imports Playwright, so apps/portal's unit tests load it
// (test/route-matrix-answer-scan.test.ts).

const listeners = new Set();

/**
 * Reports one answer the Worker gave. world.mjs calls this for every
 * request it makes; `request` is { method, path, who }, where `who` is the
 * caller's { cookie, bearer } or undefined for a signed-out request.
 */
export function heard(request, result) {
  for (const listener of listeners) listener(request, result);
}

/** Canaries in `text` that `identity` may not read: [name]. */
export function leaks(text, identity, canaries) {
  if (!text) return [];
  return canaries.filter((c) => !c.allowed.includes(identity) && text.includes(c.value)).map((c) => c.name);
}

/**
 * The world identity holding `who`'s credentials, so a step's answer is
 * judged against what that identity may read. A request with no credentials
 * is "signedOut"; one from an account a control made for itself is
 * "throwaway". No canary allows either.
 */
export function identityOf(w, who) {
  if (!who?.cookie && !who?.bearer) return "signedOut";
  const held = Object.entries(w.who).find(([, other]) => other?.cookie === who.cookie && other?.bearer === who.bearer);
  return held ? held[0] : "throwaway";
}

/**
 * Runs the positive controls in order. Returns `positives` (route -> what the
 * control wanted and got) and `cells`: each control's own answer under the
 * caller it names, then every other answer the Worker gave while it ran,
 * under the identity that asked (`step: true`).
 */
export async function runPositives(controls, w) {
  const positives = {};
  const cells = [];
  for (const [key, status, caller, run] of controls) {
    const steps = [];
    const listener = (request, result) => steps.push({ request, result });
    listeners.add(listener);
    let result;
    try {
      result = await run(w);
    } catch (error) {
      result = { status: 0, text: String(error.message ?? error) };
    } finally {
      listeners.delete(listener);
    }
    positives[key] = { caller, want: status, got: result.status, answer: result.status === status ? undefined : (result.text ?? "").slice(0, 300) };
    cells.push({ key, identity: caller, result, positive: true });
    for (const step of steps) {
      if (step.result === result) continue;
      cells.push({
        key: `${key} [step ${step.request.method} ${step.request.path}]`,
        identity: identityOf(w, step.request.who),
        result: step.result,
        positive: true,
        step: true,
      });
    }
  }
  return { positives, cells };
}

/** Every cell whose answer carries a canary its identity may not read. */
export function leakedCells(cells, canaries) {
  const leaked = [];
  for (const { key, identity, result, positive } of cells) {
    const found = leaks(result.text, identity, canaries);
    if (found.length) leaked.push({ route: positive ? `${key} [positive]` : key, identity, status: result.status, found });
  }
  return leaked;
}
