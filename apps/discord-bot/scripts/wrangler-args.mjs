/**
 * Assemble the Wrangler argument list for one of the three commands this
 * wrapper fronts.
 *
 * Split out of wrangler-safe.mjs so it can be tested: importing that file
 * spawns Wrangler as a side effect of loading it.
 *
 * The passthrough is why this exists. The wrapper read only `process.argv[2]`
 * and dropped the rest, so `deploy --dry-run` uploaded the Worker, silently.
 *
 * Still three commands: this wrapper exists for the `Cog*Portal` path
 * workaround, not as a general entry point. Run anything else, `versions list`
 * and `rollback` included, against Wrangler directly.
 */

const COMMANDS = ["build", "deploy", "dev"];

const USAGE = `Usage: node scripts/wrangler-safe.mjs <${COMMANDS.join("|")}> [wrangler flags...]`;

export function buildArgs(argv) {
  const [command, ...passthrough] = argv;
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  // There is no `wrangler build`; a build is a deploy that stops before upload.
  const base =
    command === "build" ? ["deploy", "--dry-run", "--outdir", "dist"] : [command];
  return [...base, ...passthrough];
}
