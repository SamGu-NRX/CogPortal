import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAttemptDevice, revokeAttemptDevice, type AttemptDevice, type DevicePortal } from './devices.ts';

// A fake portal standing in for the browser: devices by id and name, which
// login is signed in, and every revoke it was asked for.
function portal(devices: { id: string; name: string }[], revokeStatus = 200) {
  const revoked: string[] = [];
  let signedInAs: string | undefined;
  const fake: DevicePortal = {
    signIn: async (login) => {
      signedInAs = login;
      return 200;
    },
    devices: async () => {
      assert.equal(signedInAs, 'e2e-pilot-a', 'devices are listed for the attempt student');
      return devices;
    },
    revoke: async (id) => {
      revoked.push(id);
      return revokeStatus;
    },
  };
  return { fake, revoked };
}

const attempt: AttemptDevice = { login: 'e2e-pilot-a', before: ['dev_old'], name: 'E2E pilot 1a2b3c4d' };

test('a CLI that collected its token and then failed still has its device revoked', async () => {
  // The test never recorded an id: the CLI exited non-zero after the portal
  // created the device, before its credential was written.
  const { fake, revoked } = portal([
    { id: 'dev_old', name: 'CogWorks CLI' },
    { id: 'dev_new', name: 'E2E pilot 1a2b3c4d' },
  ]);
  assert.equal(await revokeAttemptDevice(fake, attempt), undefined);
  assert.deepEqual(revoked, ['dev_new']);
});

test('an attempt whose CLI never collected a token has nothing to revoke', async () => {
  const { fake, revoked } = portal([{ id: 'dev_old', name: 'CogWorks CLI' }]);
  assert.equal(await revokeAttemptDevice(fake, attempt), undefined);
  assert.deepEqual(revoked, []);
});

test("devices that aren't this attempt's are left alone", async () => {
  const { fake, revoked } = portal([
    // Listed before the approval, even though it carries the name.
    { id: 'dev_old', name: 'E2E pilot 1a2b3c4d' },
    // New, but under another attempt's name.
    { id: 'dev_other', name: 'E2E pilot 99999999' },
  ]);
  assert.equal(await findAttemptDevice(fake, attempt), undefined);
  assert.equal(await revokeAttemptDevice(fake, attempt), undefined);
  assert.deepEqual(revoked, []);
});

test('two new devices under the attempt name are refused, and none is revoked', async () => {
  const { fake, revoked } = portal([
    { id: 'dev_a', name: 'E2E pilot 1a2b3c4d' },
    { id: 'dev_b', name: 'E2E pilot 1a2b3c4d' },
  ]);
  await assert.rejects(findAttemptDevice(fake, attempt), /2 new devices are named "E2E pilot 1a2b3c4d"; not guessing/);
  assert.match((await revokeAttemptDevice(fake, attempt)) ?? '', /not guessing/);
  assert.deepEqual(revoked, []);
});

test('a recorded id is revoked directly, and a failed revoke is reported', async () => {
  const { fake, revoked } = portal([], 401);
  assert.equal(await revokeAttemptDevice(fake, attempt, 'dev_recorded'), 'revoking dev_recorded returned 401');
  assert.deepEqual(revoked, ['dev_recorded']);
});
