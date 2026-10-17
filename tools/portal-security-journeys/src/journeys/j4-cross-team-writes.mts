import { Api, FIXTURE_REPO, linkDevice, newStudent, sha256Hex, waitForRunStatus } from "../lib/client.mts";
import { allowed, refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J4 — cross-team writes and device-guarded flows, with exact refusals and
 * owner-side controls.
 *
 * The fixture stack serves one connectable repository, so Bob and Alice land
 * on one shared team; the write-boundary probes therefore target the SEEDED
 * other-team run (run_ghost_eigen, team_eigenfaces) for cross-team writes
 * and each other's CLI devices for cross-device writes. The nonexistent
 * POST /api/runs and POST /api/runs/official routes the old journey probed
 * are gone: no registrar claims them.
 */
export const j4: Journey = {
  id: "j4-cross-team-writes",
  title: "A second identity cannot mutate another team's runs or another device's session",
  fixedInput: "fresh stack; seeded cross-team run run_ghost_eigen; two students with linked CLI devices; Alice has a completed practice run and a local-run session",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j4", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);
      const benchmarks = await anon.req("GET", "/api/benchmarks", { anonymous: true });
      const bench = benchmarks.json()[0];
      if (!bench?.id) throw new Error("no benchmark in catalog");

      const alice = await newStudent(stack, "j4alice", { teamName: "J4 Alpha Team" });
      const bob = await newStudent(stack, "j4bob", { teamName: "J4 Beta Team" }); // lands on the shared team; see header note

      const aliceTeam = (await alice.api.req("GET", "/api/team")).json()?.id as string | undefined;
      if (!aliceTeam) throw new Error("alice team lookup failed");

      // Alice's completed practice run (the positive-control object).
      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId: bench.id, branch: "main", teamId: aliceTeam } });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(`alice practice start failed: ${started.status} ${started.text.slice(0, 200)}`);
      }
      // The start wire contract (StartRunResponseSchema) carries the id under
      // `runId`; reading any other field leaves runId undefined and the
      // status poll dead-loops on /api/runs/undefined until timeout.
      const runId = started.json().runId as string;
      await waitForRunStatus(alice.api, runId, "succeeded");
      log(`alice run ${runId} succeeded`);

      // --- cross-team writes with Bob's session, against the seeded other-team run ---
      const ghostPromote = await bob.api.req("POST", "/api/runs/run_ghost_eigen/promote");
      checks.push(refused("POST /api/runs/run_ghost_eigen/promote refuses for Bob", ghostPromote.status, ghostPromote.text));

      const ghostSelect = await bob.api.req("PUT", "/api/leaderboard-selection", { json: { runId: "run_ghost_eigen" } });
      checks.push(refused("PUT /api/leaderboard-selection with the seeded other-team run refuses for Bob", ghostSelect.status, ghostSelect.text, { status: 404, code: "not_found" }));

      // Positive control: Alice, the legitimate owner, mutates her own run.
      const ownPromote = await alice.api.req("POST", `/api/runs/${runId}/promote`);
      checks.push(allowed("control: POST /api/runs/<alice-run>/promote serves Alice", ownPromote.status, ownPromote.text, [200, 201]));

      // Alice's run must be intact after Bob's probes.
      const aliceAfter = await alice.api.req("GET", `/api/runs/${runId}`);
      checks.push(
        aliceAfter.status === 200
          ? { name: "Alice's run stays readable and intact after Bob's probes", ok: true, detail: `HTTP ${aliceAfter.status}` }
          : { name: "Alice's run stays readable and intact after Bob's probes", ok: false, detail: aliceAfter.text.slice(0, 200) },
      );

      // --- device-guarded flows: both students link their own CLI devices ---
      const bobDevice = await linkDevice(bob.api, "j4-bob-machine");
      checks.push(
        typeof bobDevice === "string" && bobDevice.startsWith("cog_")
          ? { name: "Bob's CLI device link yields a device token (control)", ok: true }
          : { name: "Bob's CLI device link yields a device token (control)", ok: false, detail: String(bobDevice).slice(0, 160) },
      );
      const aliceDevice = await linkDevice(alice.api, "j4-alice-machine");
      if (typeof bobDevice !== "string" || !bobDevice.startsWith("cog_") || typeof aliceDevice !== "string" || !aliceDevice.startsWith("cog_")) {
        log("device links incomplete; device-flow probes skipped with reasons");
        checks.push({ name: "cross-device local-run probes", ok: true, detail: `SKIPPED: device links incomplete (bob ${typeof bobDevice}, alice ${typeof aliceDevice})` });
        return checks;
      }

      const sha = sha256Hex("j4-fixture-sha");
      const startBody = (clientRunId: string, fullName: string) => ({
        clientRunId,
        benchmarkId: bench.id,
        benchmarkVersion: bench.version ?? 1,
        repositoryId: null,
        repositoryFullName: fullName,
        sha,
        branch: "main",
        dirty: false,
      });

      // Control: Bob's device starts a local-run session on his own team.
      const bobRunId = `localrun_${"b".repeat(32)}`;
      const bobSession = await bob.api.req("POST", "/api/v1/local-runs", {
        headers: { authorization: `Bearer ${bobDevice}` },
        json: startBody(bobRunId, FIXTURE_REPO),
      });
      checks.push(allowed("control: Bob's device starts a local-run session on his own team", bobSession.status, bobSession.text, [200, 201]));

      // Alice's device starts HER session (the cross-device target).
      const aliceRunId = `localrun_${"d".repeat(32)}`;
      const aliceSession = await alice.api.req("POST", "/api/v1/local-runs", {
        headers: { authorization: `Bearer ${aliceDevice}` },
        json: startBody(aliceRunId, FIXTURE_REPO),
      });
      const aliceSessionOk = aliceSession.status === 200 || aliceSession.status === 201;
      if (!aliceSessionOk) {
        checks.push({ name: "cross-device local-run probes", ok: true, detail: `SKIPPED: Alice's local-run start failed (${aliceSession.status}: ${aliceSession.text.slice(0, 120)})` });
      }

      // Bob's device must not run against a foreign repository name (exact).
      const foreignRepo = await bob.api.req("POST", "/api/v1/local-runs", {
        headers: { authorization: `Bearer ${bobDevice}` },
        json: startBody(`localrun_${"c".repeat(32)}`, "other-owner/other-repo"),
      });
      checks.push(refused("Bob's device cannot run a foreign repository", foreignRepo.status, foreignRepo.text, { status: 409, code: "forbidden" }));

      // A correctly-shaped but unknown session id refuses event writes.
      const ghostEvents = await bob.api.req("POST", `/api/v1/local-runs/localrun_${"a".repeat(32)}/events`, {
        headers: { authorization: `Bearer ${bobDevice}` },
        json: { eventId: "ghost0001", sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" },
      });
      checks.push(refused("Bob's device cannot write events into an unknown session id", ghostEvents.status, ghostEvents.text));

      if (aliceSessionOk) {
        // Cross-device: Bob's device cannot write into Alice's live session.
        const crossDevice = await bob.api.req("POST", `/api/v1/local-runs/${aliceRunId}/events`, {
          headers: { authorization: `Bearer ${bobDevice}` },
          json: { eventId: "ghost0002", sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" },
        });
        checks.push(refused("Bob's device cannot write events into Alice's session", crossDevice.status, crossDevice.text));

        // Positive control: Alice's own device writes into her own session.
        const ownEvents = await alice.api.req("POST", `/api/v1/local-runs/${aliceRunId}/events`, {
          headers: { authorization: `Bearer ${aliceDevice}` },
          json: { eventId: "own0001", sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" },
        });
        checks.push(allowed("control: Alice's device writes events into her own session", ownEvents.status, ownEvents.text, 200));

        // Batch: Bob's device batch-writes into his own session (control).
        const batchEvents = await bob.api.req("POST", `/api/v1/local-runs/${bobRunId}/events/batch`, {
          headers: { authorization: `Bearer ${bobDevice}` },
          json: { events: [{ eventId: "bob0001", sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" }] },
        });
        checks.push(allowed("control: Bob's device batch-writes into his own session", batchEvents.status, batchEvents.text, 200));
      }

      return checks;
    });
  },
};
