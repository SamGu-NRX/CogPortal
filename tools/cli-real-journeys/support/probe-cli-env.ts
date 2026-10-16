import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliHome } from "./cli.ts";
import { readStackInfo } from "./stack-info.ts";

/**
 * Pre-flight probe, run by run-all.sh right after the loopback guard: spawns
 * a CLI subprocess through the suite's real CliHome path and shows the
 * COGPORTAL_URL that process actually received. It must be the booted local
 * stack's loopback origin even when the suite itself was started with a
 * hostile value exported — anything else means the pinning regressed, and
 * the run stops loudly before a single journey starts.
 *
 * The "CLI" is a throwaway venv-shaped bin whose cogworks prints its
 * environment; no stack request is made, so this works before any journey.
 */
const info = await readStackInfo();

const bin = await mkdtemp(join(tmpdir(), "cog-probe-venv-"));
await writeFile(join(bin, "cogworks"), '#!/bin/sh\nprintf \'COGPORTAL_URL=%s\\n\' "$COGPORTAL_URL"\n');
await chmod(join(bin, "cogworks"), 0o755);
await writeFile(join(bin, "python"), "#!/bin/sh\n");
await chmod(join(bin, "python"), 0o755);

const home = await CliHome.create(bin);
try {
  const probe = home.start(["--print-env"]);
  const printed = await probe.waitFor(/COGPORTAL_URL=(.*)/, 10_000);
  const seen = printed[1].trim();
  if (seen !== info.shaperPortalOrigin) {
    console.error(
      `probe FAILED: the CLI subprocess saw COGPORTAL_URL=${seen || "(unset)"}, ` +
        `but the booted stack's origin is ${info.shaperPortalOrigin}. ` +
        `The suite must pin every CLI process to the local stack.`,
    );
    process.exit(1);
  }
  console.log(
    `probe: ok — a CLI subprocess through CliHome sees COGPORTAL_URL=${seen} ` +
      `(the booted stack's loopback origin)`,
  );
} finally {
  await home.close();
  await rm(bin, { recursive: true, force: true });
}
