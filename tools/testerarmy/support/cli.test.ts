import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CliHome } from './cli.ts';

// Stub executables stand in for Python: CliHome passes them `-c <code> <args>`,
// which a shell script ignores. Each test points PILOT_CLI_PYTHON at one.
let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cog-pilot-clitest-'));
  process.env.PILOT_CLI_SRC = scratch;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function stub(name: string, body: string): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test('a CLI that cannot start rejects its waiters, and close still removes HOME', async () => {
  process.env.PILOT_CLI_PYTHON = join(scratch, 'no-such-python');
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await assert.rejects(cli.waitFor(/Open/, 2_000), /could not run/);
  await assert.rejects(cli.exited(2_000), /could not run/);
  await home.close();
  assert.equal(await exists(home.path), false);
});

test('output and exit code come through', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('prints', 'echo "Open http://127.0.0.1:5195/x and confirm code AB12."; exit 3');
  const home = await CliHome.create();
  const cli = home.start(['link']);
  const [, url, code] = await cli.waitFor(/^Open (\S+) and confirm code (\S+)\.$/m, 2_000);
  assert.equal(url, 'http://127.0.0.1:5195/x');
  assert.equal(code, 'AB12');
  assert.equal(await cli.exited(2_000), 3);
  await home.close();
});

test('a CLI that exits first rejects a pattern it never printed', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('quits', 'echo nothing useful; exit 2');
  const home = await CliHome.create();
  await assert.rejects(home.start(['link']).waitFor(/Open/, 2_000), /exited 2 first/);
  await home.close();
});

test('close stops a running CLI and waits for it before removing HOME', async () => {
  const seen = join(scratch, 'seen-at-exit');
  // On TERM it pauses, then records whether HOME still exists as it exits.
  process.env.PILOT_CLI_PYTHON = await stub(
    'polls',
    `trap 'sleep 0.3; if [ -d "$HOME" ]; then echo present > "${seen}"; else echo gone > "${seen}"; fi; exit 0' TERM
echo polling
while :; do sleep 0.05; done`,
  );
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await cli.waitFor(/polling/, 2_000);
  await home.close();
  assert.equal((await readFile(seen, 'utf8')).trim(), 'present');
  assert.equal(await exists(home.path), false);
});

test('close escalates to SIGKILL for a CLI that ignores SIGTERM', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('stubborn', `trap '' TERM\necho stubborn\nwhile :; do sleep 0.05; done`);
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await cli.waitFor(/stubborn/, 2_000);
  await home.close();
  assert.equal(await exists(home.path), false);
  assert.equal(await cli.exited(1_000), 128);
});
