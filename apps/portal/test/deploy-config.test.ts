import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseJsonc } from "./jsonc.ts";

/**
 * Does the deployed configuration say what we think it says?
 *
 * Wrangler keys are non-inheritable: `vars`, `routes` and every binding have to
 * be restated inside `env.production`, and nothing warns when one of them is
 * not. That is the shape of almost every production configuration bug this
 * project has had. A variable is added to staging, the production block is not
 * touched, and the difference only appears when a student hits the surface that
 * needed it.
 *
 * Parse configuration rather than matching comments that describe it.
 */

interface Route {
  pattern: string;
  custom_domain?: boolean;
}

interface Environment {
  vars: Record<string, string>;
  routes: Route[];
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
}

interface WranglerConfig extends Environment {
  name: string;
  env: { production: Environment };
}

async function loadConfig(): Promise<WranglerConfig> {
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return parseJsonc<WranglerConfig>(text);
}

function environments(config: WranglerConfig): Array<[string, Environment]> {
  return [
    ["staging", config],
    ["production", config.env.production],
  ];
}

test("production restates every variable staging declares", async () => {
  const config = await loadConfig();
  // Set equality in both directions. A variable only production has is the
  // same class of mistake as one only staging has: somebody edited one block.
  assert.deepEqual(
    Object.keys(config.env.production.vars).sort(),
    Object.keys(config.vars).sort(),
  );
});

test("an environment set to modal carries what dispatch needs", async () => {
  const config = await loadConfig();
  for (const [label, environment] of environments(config)) {
    if (environment.vars.EXECUTION_PROVIDER !== "modal") continue;
    // This is `assertModalConfigured` plus `origin()` in worker/execution/
    // runner.ts, stated against configuration. Both throw 501 at dispatch
    // time; here the same mistake fails in CI instead.
    assert.match(
      environment.vars.MODAL_RUNNER_URL ?? "",
      /^https:\/\//,
      `${label} dispatches to modal without an https MODAL_RUNNER_URL`,
    );
    assert.match(
      environment.vars.PUBLIC_ORIGIN ?? "",
      /^https:\/\//,
      `${label} dispatches to modal without an https PUBLIC_ORIGIN`,
    );
  }
});

test("each environment declares a runner signing key id", async () => {
  for (const [label, environment] of environments(await loadConfig())) {
    // Both verifiers compare this against a single configured string before
    // they look at a signature (submit_job in modal_app.py,
    // verifyRunnerSignature in routes/runner-events.ts), so an empty value is
    // a bare 401 with no log line on the Modal side.
    //
    // The two environments no longer have to agree. Each Worker now dispatches
    // to its own Modal app holding its own signing secret, so what has to
    // match is this id and the id inside that app's secret, which
    // configuration cannot see. Checking they are equal to each other would
    // assert a coincidence.
    assert.match(
      environment.vars.RUNNER_SIGNING_KEY_ID ?? "",
      /\S/,
      `${label} has no RUNNER_SIGNING_KEY_ID`,
    );
  }
});

test("each environment is configured to dispatch to its own Modal app", async () => {
  const config = await loadConfig();
  // The isolation this buys: publishing a sandbox image name or rotating the
  // signing secret is a staging release step, and production must not follow
  // it. One shared endpoint made both portals one blast radius, in both
  // directions, because the secret behind it was necessarily the same value.
  //
  // This reads configuration and nothing else. That the production endpoint
  // resolves, and that it is the app this string names, is answered by reading
  // the deploy output and the deployed function's own record; see
  // docs/runbooks/platform.md, "Confirming the deploy without dispatching
  // work".
  assert.notEqual(
    config.vars.MODAL_RUNNER_URL,
    config.env.production.vars.MODAL_RUNNER_URL,
  );
  assert.match(
    config.env.production.vars.MODAL_RUNNER_URL ?? "",
    /--cogworks-runner-production-/,
    "production is configured against an app that is not cogworks-runner-production",
  );
});

test("one shared image digest never names one track's image", async () => {
  const config = await loadConfig();
  for (const [label, environment] of environments(config)) {
    // `_sandbox_image` picks one of three images by benchmark, so an immutable
    // id in this single variable is false for the two tracks it does not
    // describe. The runbook used to instruct exactly that, which is why this is
    // a test. Delete it if the runner ever reports a per-benchmark image id;
    // the constraint is the one-value-many-images mismatch, not the placeholder.
    assert.doesNotMatch(
      environment.vars.RUNNER_IMAGE_DIGEST ?? "",
      /im-[A-Za-z0-9]/,
      `${label} names one image in a variable recorded on every track's runs`,
    );
  }
});

test("each environment's origins match the hosts it is routed on", async () => {
  const config = await loadConfig();
  for (const [label, environment] of environments(config)) {
    const hosts = environment.routes.map((route) => route.pattern);
    assert.equal(
      new URL(environment.vars.PUBLIC_ORIGIN).hostname,
      hosts[0],
      `${label} PUBLIC_ORIGIN is not the host it is routed on`,
    );
    assert.equal(
      new URL(environment.vars.ACTIVITY_ORIGIN).hostname,
      hosts[1],
      `${label} ACTIVITY_ORIGIN is not the host it is routed on`,
    );
    // better-auth builds the fixed GitHub OAuth callback from this, so a stale
    // value sends the whole sign-in round trip to the other environment.
    assert.equal(
      environment.vars.BETTER_AUTH_URL,
      environment.vars.PUBLIC_ORIGIN,
      `${label} BETTER_AUTH_URL and PUBLIC_ORIGIN disagree`,
    );
  }
});

test("each environment binds ARTIFACTS to its own bucket", async () => {
  const config = await loadConfig();

  // The name matters as much as the binding: `ARTIFACTS` pointed at the other
  // environment's bucket would be invisible here and wrong there, because a
  // production run would read weights a staging team uploaded.
  assert.deepEqual(config.r2_buckets ?? [], [
    { binding: "ARTIFACTS", bucket_name: "cogportal-artifacts-dev" },
  ]);
  assert.deepEqual(config.env.production.r2_buckets ?? [], [
    { binding: "ARTIFACTS", bucket_name: "cogportal-artifacts-prod" },
  ]);
});

test("staging and production never share stored state", async () => {
  const config = await loadConfig();
  const production = config.env.production;
  assert.notEqual(config.d1_databases[0].database_id, production.d1_databases[0].database_id);
  assert.notEqual(config.d1_databases[0].database_name, production.d1_databases[0].database_name);
});
