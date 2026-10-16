import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

/**
 * The commit a pip `git+https://…@<commit>` direct reference pins (the 40-hex
 * commit in the source), or "" when the source names none. Pure, so the
 * receipts' pin assertions and the wiring test read a source identically.
 */
export function pinSourceCommit(source: string): string {
  return source.match(/@([0-9a-f]{40})/)?.[1] ?? "";
}

/**
 * The `git+https://…@<commit>` COGBENCH_SOURCE (or a package entry's source)
 * that the revision `rev`'s copy of apps/portal/src/lib/benchmark-packages.ts
 * declares — read with `git show`, the same way run-all.sh reads it, never
 * from the working tree. Throws when the revision declares no source.
 */
export async function pinnedSource(repoRoot: string, rev: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repoRoot, "show", `${rev}:apps/portal/src/lib/benchmark-packages.ts`]);
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*"git\+([^"]*)"/);
    if (match) return `git+${match[1]}`;
  }
  throw new Error(`${rev}:apps/portal/src/lib/benchmark-packages.ts declares no git+ source`);
}

const READER = fileURLToPath(new URL("./installed_commit.py", import.meta.url));

/** The pip direct-url record of an installed distribution, parsed, or null
 * when the distribution is absent or did not come from a URL. Read by the
 * selected interpreter through importlib.metadata (support/installed_commit.py),
 * so any site-packages layout works, native Windows included. */
export async function readDirectUrl(
  pythonBin: string,
  distribution: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, any> | null> {
  try {
    const { stdout } = await run(pythonBin, [READER, distribution], { env });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The resolved commit pip recorded under vcs_info, or "" when absent. */
export function directUrlCommit(record: Record<string, any>): string {
  return typeof record?.vcs_info?.commit_id === "string" ? record.vcs_info.commit_id : "";
}

/**
 * The installed-commit assertion every pin receipt makes: the distribution
 * actually installed in the environment is the exact git source the pin's
 * portal revision declares — same repository, same resolved commit. Returns
 * the evidence pair instead of throwing, so callers name both sides in their
 * receipts.
 */
export function installedMatchesPin(
  installed: Record<string, any> | null,
  pinSource: string,
): { ok: boolean; installedCommit: string; pinCommit: string; installedUrl: string } {
  const installedUrl = installed && typeof installed.url === "string" ? installed.url : "";
  const pinCommit = pinSourceCommit(pinSource);
  const installedCommit = installed ? directUrlCommit(installed) : "";
  return {
    ok:
      installed !== null &&
      installedUrl === pinRepositoryUrl(pinSource) &&
      pinCommit.length === 40 &&
      installedCommit === pinCommit,
    installedCommit,
    pinCommit,
    installedUrl,
  };
}

/** The repository URL pip records in direct_url.json for a git+ source: the
 * source without `git+`, the `@<commit>` and any `#fragment`. */
export function pinRepositoryUrl(source: string): string {
  return source.replace(/^git\+/, "").replace(/#.*$/, "").replace(/@[0-9a-f]{40}$/, "");
}
