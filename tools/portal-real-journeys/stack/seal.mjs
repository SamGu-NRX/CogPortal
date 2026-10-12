// What the harness boots, and the check that it cannot reach anything real.
//
// Every boot runs out of a run-owned directory (see stack.mjs): its own
// wrangler config, generated here, and its own D1/R2/Durable Object state.
// Nothing reads or writes the checkout's apps/portal/.dev.vars or
// apps/portal/.wrangler.
//
// The generated config names every binding the Worker gets. It is built from
// an allowlist of fields of the checkout's wrangler.jsonc (compatibility
// settings, assets handling, Durable Objects), never by copying the file, so
// routes, crons, env.production and the deployed vars cannot ride along.
//
// After each build, `effectivePreviewVars` asks wrangler which vars the
// preview Worker will actually be given (the built wrangler.json plus any
// .dev.vars/.env wrangler would layer on), and `sealViolations` refuses the
// boot if any provider URL is off loopback or any identity matches a
// deployed one. That check runs on what wrangler resolves, not on what this
// file meant to write, because the previous harness wrote a sealed .dev.vars
// that the build's secret scrub then deleted, and the preview ran on the
// staging vars from wrangler.jsonc.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const PROVIDER_URL_VARS = ["GITHUB_API_BASE_URL", "DISCORD_API_BASE_URL", "MODAL_RUNNER_URL"];
export const ORIGIN_VARS = ["PUBLIC_ORIGIN", "BETTER_AUTH_URL", "ACTIVITY_ORIGIN"];
/** Values that identify a real deployment; none may appear in a harness boot. */
export const DEPLOYED_IDENTITY_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_APP_SLUG",
  "DISCORD_CLIENT_ID",
  "COURSE_GUILD_ID",
  "MODAL_RUNNER_URL",
  "PUBLIC_ORIGIN",
  "BETTER_AUTH_URL",
  "ACTIVITY_ORIGIN",
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Every non-empty value of the identity vars in any environment of the deployed config. */
export function deployedIdentities(rawConfig) {
  const values = new Set();
  const scopes = [rawConfig.vars ?? {}, ...Object.values(rawConfig.env ?? {}).map((env) => env.vars ?? {})];
  for (const vars of scopes) {
    for (const name of DEPLOYED_IDENTITY_VARS) {
      if (typeof vars[name] === "string" && vars[name] !== "") values.add(vars[name]);
    }
  }
  return values;
}

/**
 * Reasons this set of Worker vars must not boot. Empty means sealed.
 * `expected` pins the profile's ENVIRONMENT and EXECUTION_PROVIDER, so a boot
 * that resolved to something other than what the journey asked for refuses
 * instead of running the journey against the wrong configuration.
 */
export function sealViolations(vars, { deployed = new Set(), expected = {} } = {}) {
  const violations = [];
  for (const name of PROVIDER_URL_VARS) {
    if (!vars[name]) violations.push(`${name} is unset, so the Worker would use the real provider`);
    else if (!isLoopbackUrl(vars[name])) violations.push(`${name}=${vars[name]} is not loopback`);
  }
  for (const name of ORIGIN_VARS) {
    if (vars[name] && !isLoopbackUrl(vars[name])) violations.push(`${name}=${vars[name]} is not loopback`);
  }
  for (const [name, value] of Object.entries(vars)) {
    if (deployed.has(value)) violations.push(`${name} carries a deployed value (${value})`);
  }
  if (vars.EXECUTION_PROVIDER !== "fixture" && vars.EXECUTION_PROVIDER !== "modal") {
    violations.push(`EXECUTION_PROVIDER=${JSON.stringify(vars.EXECUTION_PROVIDER)} is neither fixture nor modal`);
  }
  for (const [name, value] of Object.entries(expected)) {
    if (vars[name] !== value) violations.push(`${name}=${JSON.stringify(vars[name])}, expected ${JSON.stringify(value)}`);
  }
  return violations;
}

/** Bindings that can never point at a remote resource in a run config. */
export function bindingViolations(config) {
  const violations = [];
  const all = [
    ...(config.d1_databases ?? []),
    ...(config.r2_buckets ?? []),
    ...(config.kv_namespaces ?? []),
    ...(config.services ?? []),
    ...(config.queues?.producers ?? []),
  ];
  for (const binding of all) {
    if (binding.remote) violations.push(`binding ${binding.binding ?? binding.name} is remote`);
  }
  if ((config.routes ?? []).length > 0 || config.route) violations.push("the run config declares routes");
  return violations;
}

/** The vars a fixed profile hands the Worker. Fake credentials, loopback everything. */
export function profileVars(profile, { base, providerUrls }) {
  const common = {
    BETTER_AUTH_SECRET: "rj-local-better-auth-secret-0000000000000000",
    BETTER_AUTH_URL: base,
    PUBLIC_ORIGIN: base,
    // The Activity is served from the same proxy under another loopback
    // host name (see VITE_ACTIVITY_HOSTNAME in stack.mjs), as it is served
    // from its own host in a deployment.
    ACTIVITY_ORIGIN: base.replace("127.0.0.1", "localhost"),
    GITHUB_API_BASE_URL: providerUrls.github,
    DISCORD_API_BASE_URL: providerUrls.discord,
    // Loopback in every profile, including fixture, where nothing should
    // dispatch at all: a dispatch that did happen lands in the double's
    // journal instead of on a runner.
    MODAL_RUNNER_URL: providerUrls.modal,
    RUNNER_SIGNING_KEY_ID: "runner-v1",
    RUNNER_SIGNING_SECRET: "rj-local-runner-signing-secret-0001",
    RUNNER_IMAGE_DIGEST: "rj-local:unpublished",
    RUNNER_PYTHON_VERSION: "3.11",
    RUN_STALE_AFTER_SECONDS: "3600",
    // Synthetic Discord identity: nothing may name the course application or guild.
    COURSE_GUILD_ID: "1111111111111111111",
    DISCORD_CLIENT_ID: "rj-local-discord-client-id",
    DISCORD_CLIENT_SECRET: "rj-local-discord-client-secret",
    DISCORD_BOT_TOKEN: "rj-local-bot-token",
    ACTIVITY_SESSION_SECRET: "rj-local-activity-session-secret-0000000000",
  };
  if (profile === "fixture" || profile === "fixture-restricted") {
    return {
      // The staff visibility setting under test (apps/portal/worker/auth/staff-visibility.ts).
      ...(profile === "fixture-restricted" ? { STAFF_VISIBILITY: "restricted" } : {}),
      ...common,
      ENVIRONMENT: "development",
      DEV_AUTH: "enabled",
      ONBOARDING_DEV_TOOLS: "enabled",
      EXECUTION_PROVIDER: "fixture",
      // Dev accounts resolve roles by account name, so these logins are
      // owners in this harness. No real person's handle.
      PLATFORM_OWNER_LOGINS: "owner-person,second-owner",
    };
  }
  if (profile === "production-refusal") {
    // Configured the way a deployed Worker is (GitHub OAuth set, dev auth
    // off, modal dispatch), with fake credentials and loopback providers.
    return {
      ...common,
      ENVIRONMENT: "production",
      DEV_AUTH: "disabled",
      ONBOARDING_DEV_TOOLS: "disabled",
      EXECUTION_PROVIDER: "modal",
      GITHUB_CLIENT_ID: "rj-prod-refusal-client-id",
      GITHUB_CLIENT_SECRET: "rj-prod-refusal-client-secret",
      GITHUB_APP_SLUG: "rj-prod-refusal-app",
      PLATFORM_OWNER_LOGINS: "owner-person",
    };
  }
  throw new Error(`unknown stack profile ${JSON.stringify(profile)}`);
}

export const PROFILE_EXPECTATIONS = {
  fixture: { ENVIRONMENT: "development", EXECUTION_PROVIDER: "fixture", DEV_AUTH: "enabled" },
  "fixture-restricted": {
    ENVIRONMENT: "development",
    EXECUTION_PROVIDER: "fixture",
    DEV_AUTH: "enabled",
    STAFF_VISIBILITY: "restricted",
  },
  "production-refusal": { ENVIRONMENT: "production", EXECUTION_PROVIDER: "modal", DEV_AUTH: "disabled" },
};

/**
 * The run-owned wrangler config: allowlisted structure from the checkout's
 * config, absolute paths into the checkout's sources, local-only bindings.
 */
export function runWranglerConfig({ portalConfig, portalDir, vars }) {
  return {
    name: portalConfig.name,
    main: path.join(portalDir, "worker", "index.ts"),
    compatibility_date: portalConfig.compatibility_date,
    compatibility_flags: portalConfig.compatibility_flags,
    assets: {
      binding: portalConfig.assets?.binding ?? "ASSETS",
      not_found_handling: portalConfig.assets?.not_found_handling,
      run_worker_first: portalConfig.assets?.run_worker_first,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "cogportal-db",
        database_id: "a1b2c3d4-0000-4000-8000-000000000001",
        migrations_dir: path.join(portalDir, "migrations"),
      },
    ],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "rj-local-artifacts" }],
    durable_objects: portalConfig.durable_objects,
    migrations: portalConfig.migrations,
    vars,
  };
}

/** wrangler, resolved from the portal's own dependencies. */
export async function loadWrangler(portalDir) {
  const require = createRequire(path.join(portalDir, "package.json"));
  return import(require.resolve("wrangler"));
}

/** The checkout's raw wrangler.jsonc, comments and trailing commas allowed. */
export async function readPortalConfig(portalDir) {
  const wrangler = await loadWrangler(portalDir);
  const configPath = path.join(portalDir, "wrangler.jsonc");
  // experimental_readRawConfig parses JSONC the way wrangler does and keeps
  // env.* intact, which deployedIdentities needs.
  const { rawConfig } = wrangler.experimental_readRawConfig
    ? wrangler.experimental_readRawConfig({ config: configPath })
    : { rawConfig: wrangler.unstable_readConfig({ config: configPath }, { hideWarnings: true }) };
  return rawConfig;
}

/**
 * What the preview Worker will be given, read the way the Cloudflare Vite
 * plugin reads it at preview time: the built Worker's wrangler.json, plus
 * whatever wrangler layers on top from .dev.vars/.env beside it.
 */
export async function effectivePreviewVars({ portalDir, builtConfigPath }) {
  const wrangler = await loadWrangler(portalDir);
  const config = wrangler.unstable_readConfig({ config: builtConfigPath }, { hideWarnings: true });
  const bindings = wrangler.unstable_getVarsForDev(config.configPath, undefined, config.vars ?? {}, undefined, true, config.secrets);
  const vars = {};
  for (const [key, binding] of Object.entries(bindings)) {
    vars[key] = typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value);
  }
  return { vars, config };
}

/** The path the plugin writes the built Worker's config to. */
export function builtWorkerConfigPath(runDir, workerName) {
  return path.join(runDir, "dist", workerName, "wrangler.json");
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
