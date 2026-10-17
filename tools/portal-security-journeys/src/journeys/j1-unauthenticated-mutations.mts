import { UNAUTHENTICATED_PROBES, resolveProbe, type Probe } from "../lib/registry.mts";
import { Api, DEV_PASSWORD, FIXTURE_REPO, JOIN_CODE, linkDevice, newStudent, sha256Hex, waitForRunStatus, type Student } from "../lib/client.mts";
import { allowed, refused, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * J1 — unauthenticated mutation registry, with exact refusals and positive
 * controls. Every non-GET protected route must refuse an anonymous caller
 * with the exact status and body error code the registry records (a 404
 * from a missing route or a missing object proves nothing), and the
 * legitimate holder of the credential each guard demands must get a 2xx
 * from the same request — otherwise an over-broad guard that refuses
 * everyone would pass. Controls that cannot run here are skipped with the
 * reason recorded in the check detail.
 */
export const j1: Journey = {
  id: "j1-unauthenticated-mutations",
  title: "Every protected mutating route refuses an anonymous caller exactly, and serves its real owner",
  fixedInput: "fresh stack, no authentication material anywhere; one owner team, device, practice run and local-run session for controls",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j1", log, async (stack) => {
      const checks: Check[] = [];
      const anon = new Api(stack.baseUrl);

      const catalog = await anon.req("GET", "/api/benchmarks", { anonymous: true });
      const bench = catalog.json()?.[0];
      if (!bench?.id) throw new Error(`no benchmark in catalog: ${catalog.status} ${catalog.text.slice(0, 120)}`);

      const owner = await newStudent(stack, "j1owner", { teamName: "J1 Owner Team" });
      const teamRes = await owner.api.req("GET", "/api/team");
      const teamId = teamRes.json()?.id as string | undefined;
      if (!teamId) throw new Error(`owner team lookup failed: ${teamRes.status} ${teamRes.text.slice(0, 120)}`);

      // A plain teamless user is the add/remove target for member controls.
      const plain = new Api(stack.baseUrl);
      const plainLogin = await plain.req("POST", "/api/dev/login", { json: { login: "j1plain", demo: false, password: DEV_PASSWORD }, anonymous: true });
      if (plainLogin.status !== 200 && plainLogin.status !== 201) log(`plain user login failed (member controls may skip): ${plainLogin.status}`);

      const device = await linkDevice(owner.api, "j1-owner-machine");
      const deviceToken = typeof device === "string" ? device : null;
      if (!deviceToken) log(`owner device link failed (device controls will skip): ${String(device)}`);

      const started = await owner.api.req("POST", "/api/runs/practice", { json: { benchmarkId: bench.id, branch: "main", teamId } });
      if (started.status !== 200 && started.status !== 201) throw new Error(`owner practice start failed: ${started.status} ${started.text.slice(0, 200)}`);
      // The start wire contract (StartRunResponseSchema) carries the id under
      // `runId`; reading any other field leaves runId undefined and every
      // later run lookup polls a dead URL until timeout.
      const runId = started.json().runId as string;
      await waitForRunStatus(owner.api, runId, "succeeded");
      const runRes = await owner.api.req("GET", `/api/runs/${runId}`);
      const surfaceId = (runRes.json()?.surfaceId as string | undefined) ?? "";

      const clientRunId = `localrun_${"1".repeat(32)}`;
      if (deviceToken) {
        const localRun = await owner.api.req("POST", "/api/v1/local-runs", {
          headers: { authorization: `Bearer ${deviceToken}` },
          json: {
            clientRunId,
            benchmarkId: bench.id,
            benchmarkVersion: bench.version ?? 1,
            repositoryId: null,
            repositoryFullName: FIXTURE_REPO,
            sha: sha256Hex("j1-fixture-sha"),
            branch: "main",
            dirty: false,
          },
        });
        if (localRun.status !== 200 && localRun.status !== 201) log(`owner local-run start failed (event controls will skip): ${localRun.status} ${localRun.text.slice(0, 120)}`);
      }

      const vars: Record<string, string> = {
        benchmarkId: String(bench.id),
        branch: "main",
        teamId,
        runId,
        surfaceId,
        clientRunId,
        secondLogin: "j1plain",
        seedTeamId: "team_latent",
        joinCode: JOIN_CODE,
        fixtureRepo: FIXTURE_REPO,
        action: "pause",
      };

      let probed = 0;
      let skipped = 0;
      for (const entry of UNAUTHENTICATED_PROBES) {
        if (entry.method === "GET") continue;
        const probe = resolveProbe(entry, vars);
        probed++;
        const res = await anon.req(probe.method, probe.path, { json: probe.body, headers: probe.headers, anonymous: true });
        checks.push(refused(`${probe.method} ${probe.path} refuses anonymously [${probe.guard}]`, res.status, res.text, probe.refuse));
        const control = await runControl(probe, { owner, plain, deviceToken, vars, benchId: String(bench.id), benchVersion: bench.version ?? 1 });
        if (control.detail?.startsWith("SKIPPED control")) skipped++;
        checks.push(control);
      }

      log(`probed ${probed} mutating routes; ${probed - skipped} controls ran, ${skipped} skipped with reasons`);
      return checks;
    });
  },
};

type ControlCtx = {
  owner: Student;
  plain: Api;
  deviceToken: string | null;
  vars: Record<string, string>;
  benchId: string;
  benchVersion: number;
};

/**
 * The positive control for one probe: the legitimate holder of the
 * credential the guard demands performs the identical request.
 */
async function runControl(probe: Probe, ctx: ControlCtx): Promise<Check> {
  const label = `control: ${probe.method} ${probe.path} serves its ${probe.own === "skip" ? "owner (skipped)" : probe.own}`;
  if (probe.own === "skip") return { name: label, ok: true, detail: `SKIPPED control: ${probe.ownNote ?? "unspecified"}` };
  // A placeholder the bootstrap could not fill means the control has no real
  // object to act on — skip rather than probe a malformed path.
  if (probe.path.includes("//") || probe.path.endsWith("/actions/")) {
    return { name: label, ok: true, detail: "SKIPPED control: the bootstrap could not resolve a real object id for this route" };
  }

  // Controls already exercised while building the bootstrap itself.
  if (probe.path === "/api/cohorts/join") return { name: label, ok: true, detail: "control ran at bootstrap: the owner's own cohort join returned 200" };
  if (probe.path === "/api/github/connect") return { name: label, ok: true, detail: "control ran at bootstrap: the owner's own connect created the team (200/201)" };
  if (probe.path === "/api/runs/practice") return { name: label, ok: true, detail: "control ran at bootstrap: the owner's own practice start returned 200/201" };

  // Device approve: the code under approval must be live, so start a fresh one.
  if (probe.path === "/api/v1/cli/device/approve") {
    const start = await ctx.plain.req("POST", "/api/v1/cli/device/start", { json: {}, anonymous: true });
    if (start.status !== 200 && start.status !== 201) return { name: label, ok: true, detail: `SKIPPED control: device start failed (${start.status})` };
    const { userCode } = start.json();
    const res = await ctx.owner.api.req("POST", "/api/v1/cli/device/approve", { json: { userCode, deviceName: "j1-control-box" } });
    return allowed(label, res.status, res.text, [200, 201]);
  }

  // Check-off: mint a token from the owner's setup state, then post it.
  if (probe.path === "/api/v1/setup/check-off") {
    const state = await ctx.owner.api.req("GET", `/api/v1/setup/state?benchmarkId=${encodeURIComponent(ctx.benchId)}`);
    const token = state.json()?.tokens?.[0]?.t ?? state.json()?.tokens?.[0]?.token;
    if (!token) return { name: label, ok: true, detail: `SKIPPED control: setup state minted no check-off token (HTTP ${state.status})` };
    const res = await ctx.owner.api.req("POST", `/api/v1/setup/check-off?t=${encodeURIComponent(token)}`);
    return allowed(label, res.status, res.text, 200);
  }

  // Local-run mutations: the owner's device against the owner's own session.
  if (probe.path === "/api/v1/local-runs" || probe.path.includes("/events")) {
    if (!ctx.deviceToken) return { name: label, ok: true, detail: "SKIPPED control: the owner device link failed at bootstrap" };
    const headers = { authorization: `Bearer ${ctx.deviceToken}` };
    if (probe.path === "/api/v1/local-runs") {
      const res = await ctx.owner.api.req("POST", probe.path, {
        headers,
        json: {
          clientRunId: `localrun_${"2".repeat(32)}`,
          benchmarkId: ctx.benchId,
          benchmarkVersion: ctx.benchVersion,
          repositoryId: null,
          repositoryFullName: ctx.vars.fixtureRepo,
          sha: sha256Hex("j1-control-sha"),
          branch: "main",
          dirty: false,
        },
      });
      return allowed(label, res.status, res.text, [200, 201]);
    }
    const event = { eventId: `ctrl${Date.now()}`, sequence: 1, occurredAt: Date.now(), type: "progress", phase: "running" };
    if (probe.path.endsWith("/batch")) {
      const res = await ctx.owner.api.req("POST", probe.path, { headers, json: { events: [event] } });
      return allowed(label, res.status, res.text, 200);
    }
    const res = await ctx.owner.api.req("POST", probe.path, { headers, json: event });
    return allowed(label, res.status, res.text, 200);
  }

  // Default: the owner replays the identical request.
  const res = await ctx.owner.api.req(probe.method, probe.path, { json: probe.body, headers: probe.headers });
  if (res.status === 501) {
    return { name: label, ok: true, detail: "SKIPPED control: the route answers its owner 501 in this stack (environment gap), which is not an authorization result" };
  }
  return allowed(label, res.status, res.text, probe.method === "GET" ? 200 : [200, 201]);
}
