// predev guard for `pnpm dev` (see the "predev" script in package.json).
//
// wrangler.jsonc's top-level vars are the deployed staging worker's
// configuration, and they set EXECUTION_PROVIDER="modal" with the staging
// MODAL_RUNNER_URL. A dev boot that inherits them dispatches practice runs to
// the real staging runner. This guard refuses to start unless the dev boot's
// effective EXECUTION_PROVIDER is exactly "fixture", or it is "modal" and the
// developer opted in with ALLOW_MODAL_EXECUTION_IN_DEV.
//
// "Effective" means what the Worker will actually be given. The guard does
// not parse .dev.vars itself: an earlier hand-written parser read
// `EXECUTION_PROVIDER=modal#comment` as the string "modal#comment" while
// dotenv strips the comment and hands the Worker "modal". So it asks wrangler,
// with the same calls the Cloudflare Vite plugin makes for `vite dev`:
// vite's loadEnv for CLOUDFLARE_ENV (which can come from a .env file),
// wrangler's readConfig for that environment's vars, then getVarsForDev for
// .dev.vars / .dev.vars.<env> / .env fallback layered on top.
//
// COGPORTAL_DEV_GUARD_ROOT overrides the portal directory; the tests use it to
// run the CLI against a temporary portal with its own config and vars files.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXECUTION_PROVIDER_VAR = "EXECUTION_PROVIDER";
export const ALLOW_MODAL_EXECUTION_IN_DEV = "ALLOW_MODAL_EXECUTION_IN_DEV";

/**
 * The vars a `vite dev` boot of the portal at `root` hands the Worker, as
 * plain strings (JSON vars are stringified). Throws when wrangler cannot read
 * the configuration; the caller fails closed on that.
 */
export async function effectiveDevVars(root, { mode = "development" } = {}) {
  const [{ loadEnv }, wrangler] = await Promise.all([import("vite"), import("wrangler")]);
  // The plugin copies these into process.env before reading the config, so
  // wrangler's own flags (CLOUDFLARE_INCLUDE_PROCESS_ENV and the rest) can
  // come from a .env file too.
  const prefixed = loadEnv(mode, root, ["CLOUDFLARE_", "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_"]);
  Object.assign(process.env, prefixed);
  const cloudflareEnv = prefixed.CLOUDFLARE_ENV || undefined;
  const configPath = prefixed.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
    ? resolve(root, prefixed.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH)
    : resolve(root, "wrangler.jsonc");
  const config = wrangler.unstable_readConfig({ config: configPath, env: cloudflareEnv }, { hideWarnings: true });
  const bindings = wrangler.unstable_getVarsForDev(
    config.configPath,
    undefined,
    config.vars ?? {},
    cloudflareEnv,
    true,
    config.secrets,
  );
  const vars = {};
  for (const [key, binding] of Object.entries(bindings)) {
    vars[key] = typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value);
  }
  return { vars, cloudflareEnv, configPath: config.configPath };
}

function optInGranted(vars) {
  const value = vars[ALLOW_MODAL_EXECUTION_IN_DEV];
  return typeof value === "string" && /^(1|true)$/i.test(value.trim());
}

/**
 * Decide whether a dev boot may start, from its effective vars. Fail closed:
 * exactly "fixture" passes; exactly "modal" passes with the opt-in; anything
 * else (missing, empty, misspelled, "modal" without the opt-in) refuses. The
 * Worker itself only accepts those two values, so refusing a third costs a
 * developer nothing they could have used.
 */
export function evaluateDevProviderGuard(vars) {
  const provider = vars[EXECUTION_PROVIDER_VAR];
  if (provider === "fixture") return { allowed: true, provider };
  if (provider === "modal" && optInGranted(vars)) return { allowed: true, provider, optIn: true };
  return { allowed: false, provider, message: refusalMessage(provider) };
}

function refusalMessage(provider) {
  const seen = provider === undefined ? "is not set" : `resolves to ${JSON.stringify(provider)}`;
  return [
    `pnpm dev blocked: EXECUTION_PROVIDER ${seen} for this dev boot.`,
    ``,
    `This is the value wrangler hands the Worker after reading wrangler.jsonc and`,
    `your .dev.vars (or .env). wrangler.jsonc's top-level vars are the deployed staging`,
    `worker's configuration, with EXECUTION_PROVIDER="modal" and the staging`,
    `MODAL_RUNNER_URL, so anything other than "fixture" here can dispatch practice`,
    `runs to the real staging Modal runner.`,
    ``,
    `To develop against the fixture provider, copy apps/portal/.dev.vars.example to`,
    `apps/portal/.dev.vars and keep:`,
    ``,
    `  EXECUTION_PROVIDER="fixture"`,
    ``,
    `Only if you need the real Modal runner locally, set both lines in your own`,
    `apps/portal/.dev.vars:`,
    ``,
    `  EXECUTION_PROVIDER="modal"`,
    `  ${ALLOW_MODAL_EXECUTION_IN_DEV}="1"`,
    ``,
    `The opt-in is read only by this guard, never by the Worker. See "Running`,
    `against the real Modal runner, locally" in .dev.vars.example.`,
  ].join("\n");
}

async function main() {
  const root = process.env.COGPORTAL_DEV_GUARD_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
  let effective;
  try {
    effective = await effectiveDevVars(root);
  } catch (error) {
    console.error(`dev-execution-provider guard: wrangler could not read this portal's dev configuration.`);
    console.error(`  ${error.message}`);
    console.error("  Refusing to start, because the provider the Worker would get is unknown.");
    process.exit(1);
  }
  const result = evaluateDevProviderGuard(effective.vars);
  if (!result.allowed) {
    console.error(result.message);
    process.exit(1);
  }
  const where = effective.cloudflareEnv ? ` (CLOUDFLARE_ENV=${effective.cloudflareEnv})` : "";
  console.log(
    `dev guard: EXECUTION_PROVIDER=${result.provider}${where}${result.optIn ? ` with ${ALLOW_MODAL_EXECUTION_IN_DEV}` : ""}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
