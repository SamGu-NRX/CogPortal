import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting, type BenchmarkSetup, type CliHome } from './cli.ts';

// The Week 3 language benchmark, run for real by the student CLI against a
// small local team repository. This is a functional flow on an existing
// course environment, not a clean-install check. Set by whoever runs it:
//   PILOT_WEEK3_SRC      a git checkout of the Week 3 benchmark at the commit
//                        this repository pins as benchmarks/week3
//   PILOT_LANGUAGE_DATA  a directory with the cached Week 3 data files
//                        (symlinks are fine); the CLI's HOME is fresh, so
//                        without it the benchmark would download about 935 MB

export const BENCHMARK = 'language-search';

/** What the pinned benchmark writes when embed_text hands back one vector (language_search_benchmark/checks.py). */
export const ONE_DIMENSIONAL_EMBED_TEXT =
  'embed_text returned an array with 1 dimensions; expected a 2-D (rows, D) matrix';

const DATA_FILES = [
  'captions_train2014.json',
  'resnet18_features.pkl',
  'glove.6B.200d.txt.w2v',
  'glove.6B.200d.kv',
  'glove.6B.200d.kv.vectors.npy',
];

/** The tracked Week 3 reference submission, the team repository's starting point. */
const REFERENCE = 'examples/week3-language-submission';
/** The fixture team's repository (fixtures/link-team.sql). Nothing ever pushes to it. */
const ORIGIN = 'https://github.com/cogworks-demo/face-finder.git';
const AUTHOR = {
  GIT_AUTHOR_NAME: 'E2E Pilot',
  GIT_AUTHOR_EMAIL: 'e2e-pilot-a@dev.local',
  GIT_COMMITTER_NAME: 'E2E Pilot',
  GIT_COMMITTER_EMAIL: 'e2e-pilot-a@dev.local',
};

function git(cwd: string, args: readonly string[]): string {
  // No signing and no hooks from the machine's git config: the fixture
  // commits must not prompt or run anything.
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, ...AUTHOR },
    encoding: 'utf8',
  }).trim();
}

function repositoryRoot(): string {
  return git(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']);
}

/** The Week 3 checkout and data, refused unless the checkout is exactly the pinned benchmark. */
export async function week3Setup(): Promise<BenchmarkSetup> {
  const source = setting('PILOT_WEEK3_SRC');
  const data = setting('PILOT_LANGUAGE_DATA');
  const pinned = git(repositoryRoot(), ['rev-parse', 'HEAD:benchmarks/week3']);
  const head = git(source, ['rev-parse', 'HEAD']);
  if (head !== pinned) {
    throw new Error(`PILOT_WEEK3_SRC is at ${head}; this repository pins benchmarks/week3 at ${pinned}.`);
  }
  if (git(source, ['--no-optional-locks', 'status', '--porcelain']) !== '') {
    throw new Error('PILOT_WEEK3_SRC has local changes, so a run would not be the pinned benchmark.');
  }
  for (const file of DATA_FILES) {
    const present = await stat(join(data, file)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!present) throw new Error(`PILOT_LANGUAGE_DATA has no ${file}; the benchmark would download it.`);
  }
  return { source, data };
}

export interface TeamRepo {
  readonly path: string;
  head(): string;
  /** Commits an ordinary student bug: embed_text averages over the wrong axis and returns one vector. */
  commitBrokenEmbedText(): Promise<void>;
}

/**
 * A local Git repository holding the reference submission as committed at
 * this repository's HEAD, with the fixture team's repository as its origin
 * and pushing disabled. Commits take the current time, so every test run
 * gets new commit ids.
 */
export async function createTeamRepo(parent: string): Promise<TeamRepo> {
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD', REFERENCE], {
    cwd: repositoryRoot(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const staging = join(parent, 'reference-archive');
  await mkdir(staging);
  execFileSync('tar', ['-x', '-C', staging], { input: archive });
  const path = join(parent, 'team-repo');
  await rename(join(staging, REFERENCE), path);
  await rm(staging, { recursive: true });

  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'Week 3 reference submission (pilot fixture)']);
  git(path, ['remote', 'add', 'origin', ORIGIN]);
  git(path, ['config', 'remote.origin.pushurl', 'no-push://pilot-fixture']);

  return {
    path,
    head: () => git(path, ['rev-parse', 'HEAD']),
    async commitBrokenEmbedText() {
      const file = join(path, 'reference_search', '__init__.py');
      const working = 'return self.embedder.embed(captions)\n';
      const broken = 'return self.embedder.embed(captions).mean(axis=0)\n';
      const before = await readFile(file, 'utf8');
      if (!before.includes(working)) {
        throw new Error(`${REFERENCE}/reference_search/__init__.py no longer has "${working.trim()}"; update this fixture.`);
      }
      await writeFile(file, before.replace(working, broken));
      git(path, ['commit', '-q', '-am', 'Average the caption embeddings (pilot fixture: wrong axis)']);
    },
  };
}

export interface SyncedRun {
  readonly reportId: string;
  readonly sha: string;
}

/** `cogworks run`, then `cogworks sync`, as the student types them in the team repository. */
export async function runAndSync(home: CliHome, repo: TeamRepo): Promise<SyncedRun> {
  const sha = repo.head();
  const run = home.start(['run', '--benchmark', BENCHMARK], { cwd: repo.path });
  expect(await run.exited(300_000), run.output()).toBe(0);
  const [, saved] = await run.waitFor(/^saved: .+\/(local_[0-9a-f]+)\.json$/m, 1_000);
  // SAFETY: the group is mandatory in the pattern, so a match carries it.
  const reportId = saved!;
  const sync = home.start(['sync'], { cwd: repo.path });
  expect(await sync.exited(60_000), sync.output()).toBe(0);
  expect(sync.output()).toContain(`Synced ${reportId} `);
  return { reportId, sha };
}

export type LocalReport = {
  reportId: string;
  benchmarkId: string;
  benchmarkVersion: number;
  sha: string | null;
  dirty: boolean;
  command: 'test' | 'run' | null;
  diagnostics: string[];
};

/** The team's synced reports for this benchmark, as the signed-in member's API returns them. */
export function localReports(browser: Browser): Promise<LocalReport[]> {
  return browser.evaluate(
    (benchmark: string) =>
      fetch(`/api/v1/local-reports?benchmark=${benchmark}`)
        .then((response) => response.json())
        .then((reports: (Omit<LocalReport, 'command'> & { command?: 'test' | 'run' })[]) =>
          reports.map(({ reportId, benchmarkId, benchmarkVersion, sha, dirty, command, diagnostics }) => ({
            reportId,
            benchmarkId,
            benchmarkVersion,
            sha,
            dirty,
            command: command ?? null,
            diagnostics,
          })),
        ),
    BENCHMARK,
  );
}
