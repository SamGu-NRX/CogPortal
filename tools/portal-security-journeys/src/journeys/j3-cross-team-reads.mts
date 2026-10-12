import { Api, newStudent, waitForRunStatus } from "../lib/client.mts";
import { allowed, refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J3 — cross-team reads, with exact refusals and owner-side controls.
 *
 * The fixture stack serves exactly one connectable repository
 * (cogworks-demo/face-finder), so two students in one cohort land on ONE
 * shared team — a second team cannot be created through the product flow.
 * The real other-identity objects are the seeded teams' runs:
 * run_ghost_eigen belongs to seeded team_eigenfaces. Bob (on the shared
 * team, holding only his own session) probes those seeded other-team
 * objects; Alice's own run provides the positive controls.
 */
export const j3: Journey = {
  id: "j3-cross-team-reads",
  title: "A second team cannot read another team's runs, surfaces or selection",
  fixedInput: "fresh stack; seeded cross-team run run_ghost_eigen (team_eigenfaces); one student team with a completed fixture run",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j3", log, async (stack) => {
      const checks: Check[] = [];
      const benchmarks = await new Api(stack.baseUrl).req("GET", "/api/benchmarks", { anonymous: true });
      const benchmarkId = benchmarks.json()[0]?.id;
      if (!benchmarkId) throw new Error("no benchmark in catalog");

      const alice = await newStudent(stack, "j3alice", { teamName: "J3 Alpha Team" });
      const bob = await newStudent(stack, "j3bob", { teamName: "J3 Beta Team" }); // lands on the shared team; see header note

      const aliceTeam = (await alice.api.req("GET", "/api/team")).json()?.id as string | undefined;
      if (!aliceTeam) throw new Error("alice team lookup failed");
      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId, branch: "main", teamId: aliceTeam } });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(`alice practice start failed: ${started.status} ${started.text.slice(0, 200)}`);
      }
      const runId = started.json().id as string;
      const status = await waitForRunStatus(alice.api, runId, "succeeded");
      const runRes = await alice.api.req("GET", `/api/runs/${runId}`);
      const surfaceId = (runRes.json()?.surfaceId as string | undefined) ?? "";
      log(`alice run ${runId} -> ${status}`);

      // Cross-team probes against the SEEDED other-team run (team_eigenfaces).
      const ghostRun = await bob.api.req("GET", "/api/runs/run_ghost_eigen");
      checks.push(refused("GET /api/runs/run_ghost_eigen refuses for Bob (seeded other-team run)", ghostRun.status, ghostRun.text, { status: 404, code: "not_found" }));

      const ghostSelect = await bob.api.req("PUT", "/api/leaderboard-selection", { json: { runId: "run_ghost_eigen" } });
      checks.push(refused("PUT /api/leaderboard-selection with the seeded other-team run refuses for Bob", ghostSelect.status, ghostSelect.text, { status: 404, code: "not_found" }));

      const ghostPromote = await bob.api.req("POST", "/api/runs/run_ghost_eigen/promote");
      checks.push(refused("POST /api/runs/run_ghost_eigen/promote refuses for Bob (seeded other-team run)", ghostPromote.status, ghostPromote.text));

      // Leak sweep: Bob's own views never carry another team's rows.
      const bobList = await bob.api.req("GET", "/api/runs");
      checks.push(
        bobList.status === 200 && !bobList.text.includes("run_ghost_eigen") && !bobList.text.includes("run_ghost_gradient")
          ? { name: "GET /api/runs (Bob) excludes the seeded other-team run ids", ok: true }
          : { name: "GET /api/runs (Bob) excludes the seeded other-team run ids", ok: false, detail: `HTTP ${bobList.status}; ghost id leak: ${bobList.text.includes("run_ghost_eigen")}` },
      );

      const dash = await bob.api.req("GET", "/api/dashboard");
      checks.push(
        dash.status === 200 && !dash.text.includes("Eigenfaces United") && !dash.text.includes("Latent Space Cadets")
          ? { name: "GET /api/dashboard (Bob) shows no seeded other-team names", ok: true }
          : { name: "GET /api/dashboard (Bob) shows no seeded other-team names", ok: false, detail: `HTTP ${dash.status}; eigenfaces leak: ${dash.text.includes("Eigenfaces United")}` },
      );

      // Surfaces: no other-team surfaces exist in the fixture stack (the seed
      // creates none), so the unknown-id probe asserts the scoped-lookup 404.
      const ghostSurface = await bob.api.req("GET", "/api/run-surfaces/surface_00000000000000000000");
      checks.push(refused("GET /api/run-surfaces/<unknown-surface> refuses for Bob", ghostSurface.status, ghostSurface.text, { status: 404, code: "not_found" }));

      // Positive controls: Alice, the legitimate owner, reads her own objects.
      const ownRun = await alice.api.req("GET", `/api/runs/${runId}`);
      checks.push(allowed("control: GET /api/runs/<alice-run> serves Alice", ownRun.status, ownRun.text, 200));

      const ownSelect = await alice.api.req("PUT", "/api/leaderboard-selection", { json: { runId } });
      checks.push(allowed("control: PUT /api/leaderboard-selection serves Alice on her own run", ownSelect.status, ownSelect.text, [200, 201]));

      if (surfaceId) {
        const ownSurface = await alice.api.req("GET", `/api/run-surfaces/${surfaceId}`);
        checks.push(allowed("control: GET /api/run-surfaces/<alice-surface> serves Alice", ownSurface.status, ownSurface.text, 200));
      }

      return checks;
    });
  },
};
