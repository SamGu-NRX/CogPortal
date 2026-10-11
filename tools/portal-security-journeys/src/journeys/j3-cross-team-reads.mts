import { Api, newStudent, waitForRunStatus } from "../lib/client.mts";
import { refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J3 — cross-team reads. Alice and Bob are two teams on the same cohort with
 * the same fixture repository. Bob, holding only his own session, probes
 * Alice's run ids, surface ids and dashboard. The check: 404/403 everywhere,
 * and never a response body containing Alice's data.
 */
export const j3: Journey = {
  id: "j3-cross-team-reads",
  title: "A second team cannot read the first team's runs or surfaces",
  fixedInput: "two teams on the fixture repo; Alice runs a fixture practice run to completion",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j3", log, async (stack) => {
      const checks: Check[] = [];
      const benchmarks = await new Api(stack.baseUrl).req("GET", "/api/benchmarks", { anonymous: true });
      const benchmarkId = benchmarks.json()[0]?.id;
      if (!benchmarkId) throw new Error("no benchmark in catalog");

      const alice = await newStudent(stack, "j3alice", { teamName: "J3 Alpha Team" });
      const bob = await newStudent(stack, "j3bob", { teamName: "J3 Beta Team" });

      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId, branch: "main" } });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(`alice practice start failed: ${started.status} ${started.text.slice(0, 200)}`);
      }
      const runId = started.json().id as string;
      const status = await waitForRunStatus(alice.api, runId, "succeeded");
      log(`alice run ${runId} -> ${status}`);

      // Bob reaches for Alice's run by id (the id is the only secret to guess).
      const probes: [string, string][] = [
        ["GET", `/api/runs/${runId}`],
        ["GET", `/api/runs/${runId}/log`],
      ];
      for (const [method, path] of probes) {
        const res = await bob.api.req(method, path);
        const c = refused(`${method} ${path} refuses for Bob`, res.status, res.text);
        checks.push(c);
        if (res.status >= 200 && res.status < 300) {
          checks.push({
            name: `${path} body carries none of Alice's data`,
            ok: !res.text.includes("J3 Alpha Team") && !res.text.includes("j3alice"),
            detail: res.text.slice(0, 160),
          });
        }
      }

      // Bob's own list view never contains Alice's run.
      const bobList = await bob.api.req("GET", "/api/runs");
      const listOk = bobList.status === 200 && !bobList.text.includes(runId);
      checks.push(
        listOk
          ? { name: "GET /api/runs (Bob) excludes Alice's run id", ok: true }
          : { name: "GET /api/runs (Bob) excludes Alice's run id", ok: false, detail: `HTTP ${bobList.status}; body contains runId: ${bobList.text.includes(runId)}` },
      );

      // Dashboard: Bob sees his own team only.
      const dash = await bob.api.req("GET", "/api/dashboard");
      checks.push(
        dash.status === 200 && !dash.text.includes("J3 Alpha Team")
          ? { name: "GET /api/dashboard (Bob) shows only Bob's team", ok: true }
          : { name: "GET /api/dashboard (Bob) shows only Bob's team", ok: false, detail: `HTTP ${dash.status}; alice leak: ${dash.text.includes("J3 Alpha Team")}` },
      );

      // Run surfaces by id: a surface id of the right shape but no ownership.
      const ghostSurface = await bob.api.req("GET", "/api/run-surfaces/surface_00000000000000000000");
      checks.push(refused("GET /api/run-surfaces/<unknown-surface> refuses", ghostSurface.status, ghostSurface.text));

      // Leaderboard selection PUT with Alice's run id must refuse.
      const sel = await bob.api.req("PUT", "/api/leaderboard-selection", { json: { runId } });
      checks.push(refused("PUT /api/leaderboard-selection with Alice's run refuses", sel.status, sel.text));

      return checks;
    });
  },
};
