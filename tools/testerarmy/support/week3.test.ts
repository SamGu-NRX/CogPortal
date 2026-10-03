import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { CliHome, withoutGitRedirection } from './cli.ts';
import { checkedWeek3Inputs } from './week3.ts';

// The Week 3 inputs are checked here but used by a CLI running in the team
// repository, so they must leave the check as absolute paths. A throwaway
// repository stands in for the benchmark checkout, with its own HEAD as the
// pinned commit; empty files stand in for the data.
const DATA_FILES = [
  'captions_train2014.json',
  'resnet18_features.pkl',
  'glove.6B.200d.txt.w2v',
  'glove.6B.200d.kv',
  'glove.6B.200d.kv.vectors.npy',
];

let scratch: string;
let source: string;
let data: string;
let pinned: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...withoutGitRedirection(process.env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cog-pilot-week3test-'));
  source = join(scratch, 'week3');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'main']);
  await writeFile(join(source, 'README.md'), 'stand-in benchmark\n');
  git(source, ['add', 'README.md']);
  git(source, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '-m', 'stand-in']);
  pinned = git(source, ['rev-parse', 'HEAD']);
  data = join(scratch, 'data');
  await mkdir(data);
  for (const file of DATA_FILES) await writeFile(join(data, file), '');
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('relative Week 3 inputs come back absolute, and the CLI sees them that way from another directory', async () => {
  const setup = await checkedWeek3Inputs(relative(process.cwd(), source), relative(process.cwd(), data), pinned);
  assert.deepEqual(setup, { source, data });

  const cliSource = join(scratch, 'cli-src');
  await mkdir(join(cliSource, 'cogbench'), { recursive: true });
  await writeFile(join(cliSource, 'cogbench', '__init__.py'), '');
  await writeFile(join(cliSource, 'cogbench', 'cli.py'), '');
  const printer = join(scratch, 'print-inputs');
  await writeFile(printer, '#!/bin/sh\necho "$PYTHONPATH|$COGWORKS_LANGUAGE_DATA"\n');
  await chmod(printer, 0o755);
  const saved = { python: process.env.PILOT_CLI_PYTHON, src: process.env.PILOT_CLI_SRC };
  process.env.PILOT_CLI_PYTHON = printer;
  process.env.PILOT_CLI_SRC = cliSource;
  try {
    const home = await CliHome.create({ benchmark: setup });
    const cli = home.start(['run'], { cwd: home.path });
    assert.equal(await cli.exited(5_000), 0);
    assert.equal(cli.output().trim(), `${cliSource}:${source}|${data}`);
    await home.close();
  } finally {
    if (saved.python === undefined) delete process.env.PILOT_CLI_PYTHON;
    else process.env.PILOT_CLI_PYTHON = saved.python;
    if (saved.src === undefined) delete process.env.PILOT_CLI_SRC;
    else process.env.PILOT_CLI_SRC = saved.src;
  }
});

test('a relative data directory missing a file is refused, so the benchmark never downloads', async () => {
  const partial = join(scratch, 'partial-data');
  await mkdir(partial);
  for (const file of DATA_FILES.slice(1)) await writeFile(join(partial, file), '');
  await assert.rejects(
    checkedWeek3Inputs(relative(process.cwd(), source), relative(process.cwd(), partial), pinned),
    /PILOT_LANGUAGE_DATA has no captions_train2014\.json/,
  );
});

test('a checkout at another commit or with local changes is refused', async () => {
  await assert.rejects(checkedWeek3Inputs(source, data, '0'.repeat(40)), /PILOT_WEEK3_SRC is at [0-9a-f]{40}; this repository pins/);
  await writeFile(join(source, 'README.md'), 'changed\n');
  try {
    await assert.rejects(checkedWeek3Inputs(source, data, pinned), /PILOT_WEEK3_SRC has local changes/);
  } finally {
    git(source, ['checkout', '--', 'README.md']);
  }
});
