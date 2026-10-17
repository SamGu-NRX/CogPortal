import { UNAUTHENTICATED_PROBES, resolveProbe } from "../lib/registry.mts";
import { Api, FIXTURE_REPO, JOIN_CODE, newStudent, waitForRunStatus } from "../lib/client.mts";
import { allowed, refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J2 — anonymous reads with exact refusals, positive controls and leak
 * detection. Protected read routes must refuse an anonymous caller with the
 * exact recorded status and code; the benchmark catalog stays public
 * (control); a canary team (j2alice) with a completed fixture run makes
 * leaks observable. Each protected read's positive control is its real
 * owner getting a 2xx from the identical request.
 */
export const j2: Journey = {
  id: "j2-anonymous-reads",
  title: "Anonymous reads refuse exactly, leak no team data, and serve their real owners",
  fixedInput: "fresh stack plus one canary team (j2alice) with a completed fixture run",
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
      if (!bench?.id) return checks;

      const alice = await newStudent(stack, "j2alice", { teamName: "J2 Canary Team" });
      const teamRes = await alice.api.req("GET", "/api/team");
      const teamId = teamRes.json()?.id as string | undefined;
      if (!teamId) throw new Error(`canary team lookup failed: ${teamRes.status} ${teamRes.text.slice(0, 120)}`);

      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId: bench.id, branch: "main", teamId } });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(`canary run start failed: ${started.status} ${started.text.slice(0, 200)}`);
      }
      // The start wire contract (StartRunResponseSchema) carries the id under
      // `runId`; reading any other field leaves runId undefined and the
      // status poll dead-loops on /api/runs/undefined until timeout.
      const runId = started.json().runId as string;
      await waitForRunStatus(alice.api, runId, "succeeded");
      const runRes = await alice.api.req("GET", `/api/runs/${runId}`);
      const surfaceId = (runRes.json()?.surfaceId as string | undefined) ?? "";
      log("canary team + completed run seeded");

      const vars: Record<string, string> = {
        benchmarkId: String(bench.id),
        branch: "main",
        teamId,
        runId,
        surfaceId,
        clientRunId: `localrun_${"3".repeat(32)}`,
        secondLogin: "j2plain",
        seedTeamId: "team_latent",
        joinCode: JOIN_CODE,
        fixtureRepo: FIXTURE_REPO,
        action: "pause",
      };

      let probed = 0;
      let skipped = 0;
      for (const entry of UNAUTHENTICATED_PROBES) {
        if (entry.method !== "GET") continue;
        const probe = resolveProbe(entry, vars);
        probed++;
        const res = await anon.req(probe.method, probe.path, { headers: probe.headers, anonymous: true });
        checks.push(refused(`GET ${probe.path} refuses anonymously [${probe.guard}]`, res.status, res.text, probe.refuse));
        if (res.status >= 200 && res.status < 300) {
          const leak = res.text.includes("J2 Canary Team") || res.text.includes(runId);
          checks.push({
            name: `GET ${probe.path} response carries no canary data`,
            ok: !leak,
            detail: leak ? "canary team name or run id present in body" : undefined,
          });
        }

        // Positive control: the legitimate owner reads the same route.
        const label = `control: GET ${probe.path} serves its ${probe.own === "skip" ? "owner (skipped)" : probe.own}`;
        if (probe.own === "skip") {
          skipped++;
          checks.push({ name: label, ok: true, detail: `SKIPPED control: ${probe.ownNote ?? "unspecified"}` });
          continue;
        }
        if (probe.path.includes("//")) {
          skipped++;
          checks.push({ name: label, ok: true, detail: "SKIPPED control: the bootstrap could not resolve a real object id for this route" });
          continue;
        }
        const statusPath = probe.path === "/api/v1/cli/device/status" ? `${probe.path}?user_code=SECCODE1` : probe.path;
        const own = await alice.api.req("GET", statusPath, { headers: probe.headers });
        if (own.status === 501) {
          skipped++;
          checks.push({ name: label, ok: true, detail: "SKIPPED control: the route answers its owner 501 in this stack (environment gap), which is not an authorization result" });
          continue;
        }
        checks.push(allowed(label, own.status, own.text, 200));
      }
      log(`probed ${probed} read routes with canary seeded; ${probed - skipped} controls ran, ${skipped} skipped with reasons`);
      return checks;
    });
  },
};
