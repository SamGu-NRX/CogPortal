/**
 * Assemble the Wrangler argument list for one of the three commands this
 * wrapper fronts.
 *
 * Split out of wrangler-safe.mjs so it can be tested. Importing that file
 * spawns Wrangler as a side effect of loading it, so there is nothing there a
 * test can call.
 *
 * The passthrough is the reason this exists. The wrapper read only
 * `process.argv[2]` and dropped everything after it, so `deploy --dry-run`
 * uploaded the Worker: the flag that was supposed to stop it never reached
 * Wrangler, and nothing failed or warned. Flags now pass through unchanged.
 *
 * Still three commands. Fronting more of Wrangler through here would mean
 * claiming this wrapper is a general entry point, and it is not: it exists for
 * the `Cog*Portal` path workaround in wrangler-safe.mjs. Run anything else,
 * `versions list` and `rollback` included, against Wrangler directly.
 */

const COMMANDS = ["build", "deploy", "dev"];

const USAGE = `Usage: node scripts/wrangler-safe.mjs <${COMMANDS.join("|")}> [wrangler flags...]`;

/**
 * @param {string[]} argv `process.argv.slice(2)`: the command, then its flags.
 * @returns {string[]} arguments for the Wrangler CLI.
 * @throws {Error} when the command is not one of `build`, `deploy`, `dev`.
 */
export function buildArgs(argv) {
  const [command, ...passthrough] = argv;
  if (!COMMANDS.includes(command)) throw new Error(USAGE);
  // There is no `wrangler build`; a build is a deploy that stops before upload.
  const base =
    command === "build" ? ["deploy", "--dry-run", "--outdir", "dist"] : [command];
  return [...base, ...passthrough];
}
