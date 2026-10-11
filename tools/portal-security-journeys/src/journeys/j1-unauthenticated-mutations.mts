import { UNAUTHENTICATED_PROBES } from "../lib/registry.mts";
import { Api } from "../lib/client.mts";
import { refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J1 — unauthenticated mutation registry. Every non-GET protected route must
 * refuse an anonymous caller with a 4xx. A 2xx here is a hard fail; a 5xx is
 * a failure to handle, not a refusal.
 */
export const j1: Journey = {
  id: "j1-unauthenticated-mutations",
  title: "Every protected mutating route refuses an anonymous caller",
  fixedInput: "fresh stack, no authentication material anywhere",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j1", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);
      for (const probe of UNAUTHENTICATED_PROBES) {
        if (probe.method === "GET") continue;
        const res = await anon.req(probe.method, probe.path, { json: probe.body, anonymous: true });
        checks.push(refused(`${probe.method} ${probe.path} refuses anonymously [${probe.guard}]`, res.status, res.text));
      }
      log(`probed ${checks.length} mutating routes`);
      return checks;
    });
  },
};
