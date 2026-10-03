import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CliHome } from './cli.ts';
import { createTeamRepo, pinnedWeek3Commit } from './week3.ts';

// A shell inside a git hook, or a misconfigured terminal, can hand the tests
// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_CONFIG_* pointing at a real
// checkout. These tests set hostile values aimed at a sentinel repository and
// check that the fixture Git and the spawned CLI act only on their own repos.

let scratch: string;
let sentinel: string;
let hostileConfig: string;
let hookMarker: string;

/** Git with nothing inherited that could redirect it, for setting up and reading the sentinel. */
function cleanGit(cwd: string, args: readonly string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', [...args], {
    cwd,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  }).trim();
}

async function sentinelState() {
  const index = await readFile(join(sentinel, '.git', 'index'));
  return {
    head: cleanGit(sentinel, ['rev-parse', 'HEAD']),
    index: createHash('sha256').update(index).digest('hex'),
    config: await readFile(join(sentinel, '.git', 'config'), 'utf8'),
    status: cleanGit(sentinel, ['status', '--porcelain']),
  };
}

const HOSTILE_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
];

function setHostileEnvironment() {
  process.env.GIT_DIR = join(sentinel, '.git');
  process.env.GIT_WORK_TREE = sentinel;
  process.env.GIT_INDEX_FILE = join(sentinel, '.git', 'index');
  process.env.GIT_CONFIG_GLOBAL = hostileConfig;
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url';
  process.env.GIT_CONFIG_VALUE_0 = 'https://example.invalid/hijacked.git';
}

function clearHostileEnvironment() {
  for (const key of HOSTILE_KEYS) delete process.env[key];
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cog-pilot-gitenv-'));
  sentinel = join(scratch, 'sentinel');
  await mkdir(sentinel);
  cleanGit(sentinel, ['init', '-q', '-b', 'main']);
  cleanGit(sentinel, ['config', 'user.email', 'sentinel@example.invalid']);
  cleanGit(sentinel, ['config', 'user.name', 'Sentinel']);
  await writeFile(join(sentinel, 'keep.txt'), 'the sentinel must not change\n');
  cleanGit(sentinel, ['add', 'keep.txt']);
  cleanGit(sentinel, ['commit', '-q', '-m', 'sentinel']);
  // A global config whose hooks would leave a marker if anything ran them.
  const hooks = join(scratch, 'hostile-hooks');
  hookMarker = join(scratch, 'hook-ran');
  await mkdir(hooks);
  for (const hook of ['pre-commit', 'post-commit', 'commit-msg']) {
    await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${hookMarker}"\n`);
    await chmod(join(hooks, hook), 0o755);
  }
  hostileConfig = join(scratch, 'hostile.gitconfig');
  await writeFile(hostileConfig, `[core]\n\thooksPath = ${hooks}\n[user]\n\temail = hijack@example.invalid\n`);
});

after(async () => {
  clearHostileEnvironment();
  await rm(scratch, { recursive: true, force: true });
});

test('the fixture repository and the pin lookup ignore inherited Git redirection', async () => {
  const pinnedCleanly = pinnedWeek3Commit();
  const before = await sentinelState();
  const parent = await mkdtemp(join(scratch, 'fixture-'));
  setHostileEnvironment();
  try {
    assert.equal(pinnedWeek3Commit(), pinnedCleanly, 'the pin comes from this repository, not the sentinel');
    const repo = await createTeamRepo(parent);
    await repo.commitBrokenEmbedText();

    clearHostileEnvironment();
    assert.equal(cleanGit(repo.path, ['rev-parse', '--git-dir']), '.git', 'the fixture has its own repository');
    assert.equal(cleanGit(repo.path, ['rev-list', '--count', 'HEAD']), '2', 'both fixture commits landed in it');
    assert.equal(cleanGit(repo.path, ['config', 'remote.origin.url']), 'https://github.com/cogworks-demo/face-finder.git');
    assert.equal(cleanGit(repo.path, ['log', '-1', '--format=%ae']), 'e2e-pilot-a@dev.local');
    assert.equal(cleanGit(repo.path, ['status', '--porcelain']), '');
    assert.equal(repo.head(), cleanGit(repo.path, ['rev-parse', 'HEAD']));

    assert.deepEqual(await sentinelState(), before, 'the sentinel repository is untouched');
    const hookRan = await stat(hookMarker).then(
      () => true,
      () => false,
    );
    assert.equal(hookRan, false, 'no hook from the hostile config ran');
  } finally {
    clearHostileEnvironment();
  }
});

test('a spawned CLI sees no inherited GIT_* variable', async () => {
  const printer = join(scratch, 'print-git-env');
  await writeFile(printer, '#!/bin/sh\nenv | grep "^GIT_" || true\necho done\n');
  await chmod(printer, 0o755);
  process.env.PILOT_CLI_PYTHON = printer;
  process.env.PILOT_CLI_SRC = scratch;
  setHostileEnvironment();
  try {
    const home = await CliHome.create();
    const cli = home.start(['status']);
    assert.equal(await cli.exited(5_000), 0);
    assert.equal(cli.output().trim(), 'done');
    await home.close();
  } finally {
    clearHostileEnvironment();
  }
});
