import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs } from "../scripts/wrangler-args.mjs";
// One copy of the JSONC reader, kept under the portal's tests because that is
// where the larger config assertions live. See the note in that file.
import { parseJsonc } from "../../portal/test/jsonc.ts";

/**
 * Which portal does the bot talk to, and can the deploy command say so?
 *
 * Two failures this covers, both silent at runtime. A `PORTAL` binding pointed
 * at one environment with a `PORTAL_ORIGIN` on the other still answers every
 * command; it just hands students links to the wrong portal. And the deploy
 * wrapper used to drop every argument after the subcommand, so a command that
 * named an environment deployed the default configuration without complaint.
 */

interface BotConfig {
  name: string;
  services: Array<{ binding: string; service: string; entrypoint: string }>;
  vars: Record<string, string>;
  env?: Record<string, unknown>;
}

/**
 * Resolve against this file's directory with `node:path`, not with `URL`.
 *
 * This package compiles with `@cloudflare/workers-types`, so the global `URL`
 * is the Workers one and Node's own file APIs reject it. Only the string form
 * of `fileURLToPath` is safe here.
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));

async function loadJsonc<T>(relative: string): Promise<T> {
  return parseJsonc<T>(await readFile(join(testDirectory, relative), "utf8"));
}

const botConfig = () => loadJsonc<BotConfig>("../wrangler.jsonc");

test("the bot is wired to the production portal", async () => {
  const config = await botConfig();
  const portal = config.services.find((service) => service.binding === "PORTAL");
  assert.ok(portal, "no PORTAL service binding");
  assert.equal(portal.entrypoint, "PortalRpc");

  // Asserted as exact values, not as agreement between the two. A pair check
  // is satisfied by both being wrong together, which is precisely the state
  // this is meant to catch after a half-finished edit. A wrangler named
  // environment deploys as "<name>-<env>", so the portal's env.production is
  // the Worker script "cogportal-production".
  assert.equal(portal.service, "cogportal-production");
  assert.equal(config.vars.PORTAL_ORIGIN, "https://cogportal.sillion.app");
});

test("the bot stays a single Worker", async () => {
  const config = await botConfig();
  // A Discord application has one Interactions Endpoint URL, so a second
  // deployment of this Worker is a second name for an endpoint Discord cannot
  // call. If this ever needs environments, the reason has to be a second
  // Discord application, and that is an owner decision rather than a config one.
  assert.equal(config.env, undefined, "the bot config grew environments");
  assert.equal(config.name, "cogbot");
});

test("the bot and the portal agree on the course guild", async () => {
  const config = await botConfig();
  const portal = await loadJsonc<{
    vars: Record<string, string>;
    env: { production: { vars: Record<string, string> } };
  }>("../../portal/wrangler.jsonc");
  // index.ts refuses any interaction from another guild, so a mismatch here is
  // a bot that answers nothing, with no error anyone sees except a student.
  assert.equal(config.vars.COURSE_GUILD_ID, portal.env.production.vars.COURSE_GUILD_ID);
  assert.equal(config.vars.COURSE_GUILD_ID, portal.vars.COURSE_GUILD_ID);
});

test("flags reach wrangler instead of being dropped", () => {
  // The regression, in the shape that costs something: `--dry-run` is the flag
  // that stops a deploy from uploading, and the wrapper used to discard it.
  assert.deepEqual(buildArgs(["deploy", "--dry-run"]), ["deploy", "--dry-run"]);
  assert.deepEqual(buildArgs(["dev", "--port", "8788"]), ["dev", "--port", "8788"]);
});

test("build is still a dry-run deploy", () => {
  // There is no `wrangler build`, so `build` has always meant this. Extra flags
  // land after the dry-run switches rather than replacing them.
  assert.deepEqual(buildArgs(["build"]), ["deploy", "--dry-run", "--outdir", "dist"]);
  assert.deepEqual(buildArgs(["build", "--outdir", "elsewhere"]), [
    "deploy",
    "--dry-run",
    "--outdir",
    "dist",
    "--outdir",
    "elsewhere",
  ]);
});

test("an unsupported command is refused rather than forwarded", () => {
  // The wrapper fronts three commands. Anything else, `versions` and `rollback`
  // included, goes to wrangler directly; passing it through here would imply
  // this is a general entry point.
  for (const command of ["rollback", "versions", "secret", ""]) {
    assert.throws(() => buildArgs([command, "--name", "cogbot"]), /build\|deploy\|dev/);
  }
});
