import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the installed `cogworks` console script the way a student's terminal
// does: the binary from a virtualenv's bin directory, in a HOME made fresh for
// each test so the credential lands at the default ~/.cogbench/config.json.
// Only the spawned CLI gets that HOME.

/** The repository checkout three directories up from support/. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run run-all.sh or support/setup.ts first.`);
  return value;
}

/**
 * The environment without anything that points Git somewhere else. An
 * inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_CONFIG_* (a shell
 * inside a git hook sets some of these) would make a `git` run in the team
 * repository read, commit to or reconfigure another checkout instead, so no
 * GIT_* variable passes through.
 */
export function withoutGitRedirection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

export interface CliProcess {
  /** Resolves with the first match in the output; rejects if the process fails, exits, or time runs out first. */
  waitFor(pattern: RegExp, ms: number): Promise<RegExpMatchArray>;
  /** Resolves with the exit code (128 when a signal ended it); rejects if it could not start or is still running after `ms`. */
  exited(ms: number): Promise<number>;
  /** Everything it wrote so far, stdout and stderr interleaved. */
  output(): string;
}

class OwnedProcess implements CliProcess {
  private out = "";
  private code: number | null = null;
  private failure: Error | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly child: ChildProcess;
  private readonly label: string;
  /** Settles once the process has exited and its output is drained, or it failed to start. */
  readonly settled: Promise<void>;

  constructor(child: ChildProcess, label: string) {
    this.child = child;
    this.label = label;
    child.stdout?.on("data", (chunk: Buffer) => this.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.append(chunk));
    this.settled = new Promise((resolve) => {
      child.once("error", (error) => {
        this.failure = new Error(`${this.label} could not run: ${error.message}`);
        this.notify();
        resolve();
      });
      child.once("close", (exitCode, signal) => {
        this.code = exitCode ?? (signal ? 128 : 1);
        this.notify();
        resolve();
      });
    });
  }

  get running(): boolean {
    return this.code === null && this.failure === null;
  }

  stop(signal: NodeJS.Signals): void {
    if (this.running) this.child.kill(signal);
  }

  /** Whether it settles within `ms`. */
  async settledWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.settled, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return !this.running;
  }

  get name(): string {
    return this.label;
  }

  output(): string {
    return this.out;
  }

  waitFor(pattern: RegExp, ms: number): Promise<RegExpMatchArray> {
    return this.until(ms, `printed nothing matching ${String(pattern)}`, () => {
      const match = this.out.match(pattern);
      if (match) return match;
      if (this.failure) throw this.failure;
      if (this.code !== null) throw new Error(`${this.label} exited ${this.code} first. Output:\n${this.out}`);
      return undefined;
    });
  }

  exited(ms: number): Promise<number> {
    return this.until(ms, "did not exit", () => {
      if (this.failure) throw this.failure;
      return this.code ?? undefined;
    });
  }

  private append(chunk: Buffer): void {
    this.out += chunk.toString();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private until<T>(ms: number, what: string, check: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.listeners.delete(tick);
        settle();
      };
      const tick = () => {
        let value: T | undefined;
        try {
          value = check();
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        if (value !== undefined) finish(() => resolve(value));
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`${this.label} ${what} within ${ms} ms. Output so far:\n${this.out}`))),
        ms,
      );
      this.listeners.add(tick);
      tick();
    });
  }
}

/** How long a CLI gets to unwind after SIGINT before the journey escalates. */
const INTERRUPT_GRACE_MS = 10_000;
const STOP_GRACE_MS = 5_000;

/** Where the CLI finds a benchmark plugin's data, when the journey sets one. */
export interface BenchmarkData {
  /** Passed to the Week 3 benchmark as COGWORKS_LANGUAGE_DATA. */
  readonly languageData?: string;
}

/**
 * A fresh HOME and every CLI process started in it. `close()` interrupts the
 * ones still running and waits for each to exit, and only then removes HOME.
 * A CLI that doesn't exit on SIGINT is killed so the journey can end, but its
 * own cleanup never ran: HOME stays in place and the journey fails saying so.
 */
export class CliHome {
  private readonly owned: OwnedProcess[] = [];

  readonly path: string;
  /** The venv's bin directory holding the installed `cogworks`. */
  private readonly venvBin: string;
  private readonly data: BenchmarkData | undefined;

  private constructor(path: string, venvBin: string, data: BenchmarkData | undefined) {
    this.path = path;
    this.venvBin = venvBin;
    this.data = data;
  }

  static async create(venvBin: string, options: { data?: BenchmarkData } = {}): Promise<CliHome> {
    const bin = resolve(venvBin);
    for (const name of ["cogworks", "python"]) {
      const info = await stat(join(bin, name)).then((i) => i.isFile(), () => false);
      if (!info) throw new Error(`${bin} does not look like a virtualenv bin directory (${name} missing).`);
    }
    const home = await mkdtemp(join(tmpdir(), "cog-journey-home-"));
    return new CliHome(home, bin, options.data);
  }

  /**
   * Starts the installed `cogworks <args>`. The working directory defaults to
   * HOME, which is outside any repository, so `link` sends no repository
   * facts. `--no-browser` is the caller's to pass; BROWSER=/usr/bin/true backs
   * it up so nothing can open a window on the machine's screen.
   */
  start(args: readonly string[], options: { cwd?: string } = {}): CliProcess {
    const env: NodeJS.ProcessEnv = {
      ...withoutGitRedirection(process.env),
      PATH: `${this.venvBin}:${process.env.PATH ?? ""}`,
      VIRTUAL_ENV: this.venvBin.slice(0, -4),
      HOME: this.path,
      // A pinned seed keeps `main()` from re-executing the interpreter.
      PYTHONHASHSEED: "0",
      PYTHONUNBUFFERED: "1",
      // No __pycache__: in a team repository it would make the commit read
      // as dirty.
      PYTHONDONTWRITEBYTECODE: "1",
      BROWSER: "/usr/bin/true",
    };
    delete env.COGBENCH_CONFIG;
    delete env.COGWORKS_LANGUAGE_DATA;
    if (this.data?.languageData) env.COGWORKS_LANGUAGE_DATA = this.data.languageData;
    const child = spawn(join(this.venvBin, "cogworks"), args, {
      cwd: options.cwd ?? this.path,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owned = new OwnedProcess(child, `cogworks ${args[0] ?? ""}`.trim());
    this.owned.push(owned);
    return owned;
  }

  async close(): Promise<void> {
    const unconfirmed: string[] = [];
    for (const owned of this.owned) {
      if (!owned.running) continue;
      owned.stop("SIGINT");
      if (await owned.settledWithin(INTERRUPT_GRACE_MS)) continue;
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (!owned.running) break;
        owned.stop(signal);
        await owned.settledWithin(STOP_GRACE_MS);
      }
      unconfirmed.push(`${owned.name} (${owned.running ? "still running" : "killed"})`);
    }
    if (unconfirmed.length > 0) {
      throw new Error(
        `${unconfirmed.join(", ")} did not exit on SIGINT, so a benchmark worker it started may still be ` +
          `running; ${this.path} is left in place.`,
      );
    }
    await rm(this.path, { recursive: true, force: true });
  }
}

/** Makes a helper script executable; journeys that write scripts use it. */
export async function makeExecutable(path: string): Promise<void> {
  await chmod(path, 0o755);
}
