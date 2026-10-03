import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the student CLI (`cogworks`) from this repository's source, the way a
// student's terminal would, in a HOME made fresh for each test so the
// credential lands at the default ~/.cogbench/config.json. Only the spawned
// CLI gets that HOME; the test runner keeps its own, which is where the
// framework's stored model login lives.
//
// Set by whoever runs the tests:
//   PILOT_CLI_PYTHON  a Python 3.8 interpreter (the course version)
//   PILOT_CLI_SRC     this repository's python/cogbench/src

export function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see tools/testerarmy/README.md.`);
  return value;
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
  private out = '';
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
    child.stdout?.on('data', (chunk: Buffer) => this.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.append(chunk));
    this.settled = new Promise((resolve) => {
      // A spawn failure raises 'error' and may never raise 'exit'.
      child.once('error', (error) => {
        this.failure = new Error(`${this.label} could not run: ${error.message}`);
        this.notify();
        resolve();
      });
      child.once('close', (exitCode, signal) => {
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
    return this.until(ms, 'did not exit', () => {
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

const STOP_GRACE_MS = 5_000;

/** Where the CLI finds a benchmark it runs: its source checkout and the data the benchmark loads. */
export interface BenchmarkSetup {
  /** Put on PYTHONPATH after the CLI source, so it wins over an installed copy. */
  readonly source: string;
  /** Passed to the Week 3 benchmark as COGWORKS_LANGUAGE_DATA. */
  readonly data: string;
}

/**
 * A fresh HOME and every CLI process started in it. `close()` stops the ones
 * still running, waits for each to exit, and only then removes HOME; a
 * process that outlives SIGKILL leaves HOME in place and fails the test.
 */
export class CliHome {
  private readonly owned: OwnedProcess[] = [];

  readonly path: string;
  private readonly python: string;
  private readonly source: string;
  private readonly benchmark: BenchmarkSetup | undefined;

  private constructor(path: string, python: string, source: string, benchmark: BenchmarkSetup | undefined) {
    this.path = path;
    this.python = python;
    this.source = source;
    this.benchmark = benchmark;
  }

  static async create(options: { benchmark?: BenchmarkSetup } = {}): Promise<CliHome> {
    const python = setting('PILOT_CLI_PYTHON');
    const source = setting('PILOT_CLI_SRC');
    const home = await mkdtemp(join(tmpdir(), 'cog-pilot-home-'));
    return new CliHome(home, python, source, options.benchmark);
  }

  /**
   * Starts `cogworks <args>`. The working directory defaults to HOME, which
   * is outside any repository, so `link` sends no repository facts.
   * `--no-browser` is the caller's to pass; BROWSER=/usr/bin/true backs it up
   * so nothing can open a window on the machine's screen.
   */
  start(args: readonly string[], options: { cwd?: string } = {}): CliProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.path,
      PYTHONPATH: this.benchmark ? `${this.source}:${this.benchmark.source}` : this.source,
      // A pinned seed keeps `main()` from re-executing the interpreter.
      PYTHONHASHSEED: '0',
      PYTHONUNBUFFERED: '1',
      // No __pycache__: in a team repository it would make the commit read
      // as dirty, and the benchmark checkout may belong to another tree.
      PYTHONDONTWRITEBYTECODE: '1',
      BROWSER: '/usr/bin/true',
    };
    delete env.COGBENCH_CONFIG;
    delete env.COGWORKS_LANGUAGE_DATA;
    if (this.benchmark) env.COGWORKS_LANGUAGE_DATA = this.benchmark.data;
    const child = spawn(
      this.python,
      ['-c', 'import sys; from cogbench.cli import main; sys.exit(main(sys.argv[1:]))', ...args],
      { cwd: options.cwd ?? this.path, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const owned = new OwnedProcess(child, `cogworks ${args[0] ?? ''}`.trim());
    this.owned.push(owned);
    return owned;
  }

  async close(): Promise<void> {
    let survivors = 0;
    for (const owned of this.owned) {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (!owned.running) break;
        owned.stop(signal);
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([owned.settled, new Promise((resolve) => (grace = setTimeout(resolve, STOP_GRACE_MS)))]);
        clearTimeout(grace);
      }
      if (owned.running) survivors += 1;
    }
    if (survivors > 0) {
      throw new Error(`${survivors} CLI process(es) survived SIGKILL; left ${this.path} in place.`);
    }
    await rm(this.path, { recursive: true, force: true });
  }
}
