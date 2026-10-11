import { UNAUTHENTICATED_PROBES } from "../lib/registry.mts";
import { Api, newStudent, waitForRunStatus } from "../lib/client.mts";
import { refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J2 — anonymous reads. Protected read routes must refuse; the benchmark
 * catalog may be public (control). A seeded canary team (alice) with a
 * completed fixture run makes leaks observable: if her team name or run id
 * shows up in any anonymous-readable response, that check fails.
 */
export const j2: Journey = {
  id: "j2-anonymous-reads",
  title: "Anonymous reads refuse on protected routes and leak no team data",
  fixedInput: "fresh stack plus one seeded team (j2alice) with a completed fixture run",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j2", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);

      const benchmarks = await anon.req("GET", "/api/benchmarks", { anonymous: true });
      const bench = benchmarks.json()?.[0];
      checks.push(
        benchmarks.status === 200 && bench?.id != null
          ? { name: "benchmark catalog is anonymously readable (control)", ok: true }
          : { name: "benchmark catalog is anonymously readable (control)", ok: false, detail: `HTTP ${benchmarks.status}` },
      );
      if (!bench) return checks;

      const alice = await newStudent(stack, "j2alice", { teamName: "J2 Canary Team" });
      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId: bench.id, branch: "main" } });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(`canary run start failed: ${started.status} ${started.text.slice(0, 200)}`);
      }
      const runId = started.json().id as string;
      await waitForRunStatus(alice.api, runId, "succeeded");
      log("canary team + completed run seeded");

      let probed = 0;
      for (const probe of UNAUTHENTICATED_PROBES) {
        if (probe.method !== "GET") continue;
        probed++;
        const res = await anon.req(probe.method, probe.path, { anonymous: true });
        checks.push(refused(`GET ${probe.path} refuses anonymously [${probe.guard}]`, res.status, res.text));
        if (res.status >= 200 && res.status < 300) {
          const leak = res.text.includes("J2 Canary Team") || res.text.includes(runId);
          checks.push({
            name: `GET ${probe.path} response carries no canary data`,
            ok: !leak,
            detail: leak ? "canary team name or run id present in body" : undefined,
          });
        }
      }
      log(`probed ${probed} read routes with canary seeded`);
      return checks;
    });
  },
};
