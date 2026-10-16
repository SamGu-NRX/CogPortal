import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutGitRedirection } from "./cli.ts";

const run = promisify(execFile);

/**
 * A team repository the way a student's is: a real git worktree whose origin
 * names the team's connected GitHub repository, with a submission at the path
 * the week's benchmark expects. The origin URL needs no GitHub access — in
 * development the portal records the name it sees and the fixture repositories
 * (cogworks-demo/*) are seeded teams — but the CLI reads the remote name
 * through `git remote get-url origin` exactly as it would a real clone.
 */
export class TeamRepository {
  private constructor(readonly path: string) {}

  static async create(options: {
    originFullName: string;
    /** Files to write at the repository root, path -> bytes. */
    files: Record<string, string>;
    branch?: string;
  }): Promise<TeamRepository> {
    const root = await mkdtemp(join(tmpdir(), "cog-journey-repo-"));
    const env = withoutGitRedirection({ ...process.env });
    const git = async (...args: string[]) =>
      run("git", args, { cwd: root, env: { ...env, HOME: root } });

    await git("init", "--initial-branch", options.branch ?? "main");
    await git("config", "user.name", "Journey Student");
    await git("config", "user.email", "journey-student@dev.local");
    await git("remote", "add", "origin", `https://github.com/${options.originFullName}.git`);
    for (const [relative, content] of Object.entries(options.files)) {
      const target = join(root, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    await git("add", "-A");
    await git("commit", "-m", "Submission for the journey");
    return new TeamRepository(root);
  }

  /** The commit the repository currently names, to compare with a synced report. */
  async head(): Promise<string> {
    const env = withoutGitRedirection({ ...process.env });
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: this.path,
      env: { ...env, HOME: this.path },
    });
    return stdout.trim();
  }

  /** The branch the repository currently names. */
  async branch(): Promise<string> {
    const env = withoutGitRedirection({ ...process.env });
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: this.path,
      env: { ...env, HOME: this.path },
    });
    return stdout.trim();
  }

  async dispose(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}
