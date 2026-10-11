import { Api, newStudent, waitForRunStatus, sha256Hex } from "../lib/client.mts";
import { refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J4 — cross-team writes and device-guarded flows. Bob (own session, own CLI
 * device) attacks Alice's resources: promote her run, retry her run, start an
 * official run against her run id, write into her local-run session space,
 * and run his device against a foreign repository. The check: refusals, and
 * no state change on Alice's side.
 */
export const j4: Journey = {
  id: "j4-cross-team-writes",
  title: "A second team cannot mutate the first team's runs, sessions or device-guarded resources",
  fixedInput: "two teams on the fixture repo; Alice has a completed practice run; Bob links his own CLI device",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j4", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);
      const benchmarks = await anon.req("GET", "/api/benchmarks", { anonymous: true });
      const bench = benchmarks.json()[0];
      const benchmarkId = bench?.id;
      if (!benchmarkId) throw new Error("no benchmark in catalog");

      const alice = await newStudent(stack, "j4alice", { teamName: "J4 Alpha Team" });
      const bob = await newStudent(stack, "j4bob", { teamName: "J4 Beta Team" });

      // Alice's completed practice run.
      const started = await alice.api.req("POST", "/api/runs/practice", { json: { benchmarkId, branch: "main" } });
      const runId = started.json().id as string;
      await waitForRunStatus(alice.api, runId, "succeeded");
      log(`alice run ${runId} succeeded`);

      // --- cross-team writes with Bob's session ---
      const promote = await bob.api.req("POST", `/api/runs/${runId}/promote`);
      checks.push(refused("POST /api/runs/<alice-run>/promote refuses", promote.status, promote.text));

      const retry = await bob.api.req("POST", "/api/runs", { json: { runId } });
      checks.push(refused("POST /api/runs (retry Alice's run) refuses", retry.status, retry.text));

      const official = await bob.api.req("POST", "/api/runs/official", { json: { runId } });
      checks.push(refused("POST /api/runs/official against Alice's run refuses", official.status, official.text));

      // Alice's own state must be untouched after Bob's probes.
      const aliceAfter = await alice.api.req("GET", `/api/runs/${runId}`);
      checks.push(
        aliceAfter.status === 200 && aliceAfter.json()?.status === "succeeded" && aliceAfter.json()?.mode === "practice"
          ? { name: "Alice's run state unchanged after Bob's probes", ok: true }
          : { name: "Alice's run state unchanged after Bob's probes", ok: false, detail: aliceAfter.text.slice(0, 200) },
      );

      // --- device-guarded flows: Bob links his own CLI device ---
      const bobDevice = await linkDevice(bob.api, "j4-bob-machine");
      checks.push(
        typeof bobDevice === "string" && bobDevice.startsWith("cog_")
          ? { name: "Bob's CLI device link yields a device token", ok: true }
          : { name: "Bob's CLI device link yields a device token", ok: false, detail: String(bobDevice).slice(0, 160) },
      );

      if (typeof bobDevice === "string" && bobDevice.startsWith("cog_")) {
        const sha = sha256Hex("j4-fixture-sha");
        const bobSession = await bob.api.req("POST", "/v1/local-runs", {
          headers: { authorization: `Bearer ${bobDevice}` },
          json: {
            clientRunId: `localrun_${"b".repeat(32)}`,
            benchmarkId,
            benchmarkVersion: bench?.version ?? 1,
            repositoryId: null,
            repositoryFullName: "cogworks-demo/face-finder",
            sha,
            branch: "main",
            dirty: false,
          },
        });
        checks.push(
          bobSession.status === 200 || bobSession.status === 201
            ? { name: "Bob's local-run session starts on his own team", ok: true, detail: `HTTP ${bobSession.status}` }
            : { name: "Bob's local-run session starts on his own team", ok: false, detail: `HTTP ${bobSession.status}: ${bobSession.text.slice(0, 200)}` },
        );

        // Bob's device must not run against a foreign repository name.
        const foreignRepo = await bob.api.req("POST", "/v1/local-runs", {
          headers: { authorization: `Bearer ${bobDevice}` },
          json: {
            clientRunId: `localrun_${"c".repeat(32)}`,
            benchmarkId,
            benchmarkVersion: bench?.version ?? 1,
            repositoryId: null,
            repositoryFullName: "other-owner/other-repo",
            sha,
            branch: "main",
            dirty: false,
          },
        });
        checks.push(refused("Bob's device cannot run a foreign repository", foreignRepo.status, foreignRepo.text));

        // Even a correctly-shaped foreign session id refuses event writes.
        const ghostEvents = await bob.api.req("POST", `/v1/local-runs/localrun_${"a".repeat(32)}/events`, {
          headers: { authorization: `Bearer ${bobDevice}` },
          json: {
            events: [
              { eventId: "ghost0001", sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" },
            ],
          },
        });
        checks.push(refused("Bob's device cannot write events into a foreign session id", ghostEvents.status, ghostEvents.text));
      }
      return checks;
    });
  },
}

/** Walk the real device flow: start, approve with the user's session, poll for the token. */
export async function linkDevice(api: Api, deviceName: string): Promise<string | Error> {
  const start = await api.req("POST", "/v1/cli/device/start", { json: {} });
  if (start.status !== 200 && start.status !== 201) return new Error(`device start: ${start.status} ${start.text.slice(0, 200)}`);
  const { deviceCode, userCode } = start.json();
  const approve = await api.req("POST", "/v1/cli/device/approve", { json: { userCode, deviceName } });
  if (approve.status !== 200 && approve.status !== 201) return new Error(`device approve: ${approve.status} ${approve.text.slice(0, 200)}`);
  for (let i = 0; i < 6; i++) {
    const token = await api.req("POST", "/v1/cli/device/token", { json: { deviceCode } });
    if (token.status === 200 && token.json()?.accessToken) return token.json().accessToken as string;
    if (token.status !== 200) return new Error(`device token: ${token.status} ${token.text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return new Error("device token never granted after approval");
}
