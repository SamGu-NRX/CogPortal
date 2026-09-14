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
 * These parse the file rather than matching text in it. `weights.test.ts`
 * asserts bucket names with a regex, which is why that test passed for months
 * while both `r2_buckets` blocks were commented out: a regex cannot tell
 * configuration from a comment describing configuration.
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

test("both environments agree on the runner signing key id", async () => {
  const config = await loadConfig();
  // One Modal app, one secret, and both verifiers compare this against a single
  // configured string before they look at a signature (submit_job in
  // modal_app.py, verifyRunnerSignature in routes/runner-events.ts). Two
  // different values here means one environment is refused with a bare 401 and
  // no log line on the Modal side.
  assert.equal(
    config.env.production.vars.RUNNER_SIGNING_KEY_ID,
    config.vars.RUNNER_SIGNING_KEY_ID,
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

test("staging and production never share stored state", async () => {
  const config = await loadConfig();
  const production = config.env.production;
  assert.notEqual(config.d1_databases[0].database_id, production.d1_databases[0].database_id);
  assert.notEqual(config.d1_databases[0].database_name, production.d1_databases[0].database_name);

  // Both environments must actually bind ARTIFACTS, and to different buckets.
  // A staging upload that could replace a production artifact is the reason
  // these are separate, and weights are addressed by repository and commit, so
  // one shared bucket would collide on exactly the interesting case.
  assert.equal(config.r2_buckets?.[0].binding, "ARTIFACTS");
  assert.equal(production.r2_buckets?.[0].binding, "ARTIFACTS");
  assert.notEqual(config.r2_buckets?.[0].bucket_name, production.r2_buckets?.[0].bucket_name);
});
