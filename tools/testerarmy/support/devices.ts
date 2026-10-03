// Cleanup for the CLI device a test attempt approves. The portal creates the
// device when the CLI collects its token (worker/routes/connections.ts, the
// token route), and the CLI writes its credential only after that. A CLI
// that collects the token and then fails leaves a live device the test never
// recorded, so the attempt approves under a name of its own and teardown
// finds the device by that name.

/** What the cleanup needs from the portal; a browser in the tests, a fake in its unit test. */
export interface DevicePortal {
  signIn(login: string): Promise<number>;
  devices(): Promise<{ id: string; name: string }[]>;
  revoke(deviceId: string): Promise<number>;
}

/** One attempt's approval: whose device, which device ids existed before, and the name only this attempt uses. */
export interface AttemptDevice {
  readonly login: string;
  readonly before: readonly string[];
  readonly name: string;
}

async function newDevicesNamed(portal: DevicePortal, attempt: AttemptDevice): Promise<string[]> {
  const signedIn = await portal.signIn(attempt.login);
  if (signedIn !== 200) throw new Error(`could not sign in as ${attempt.login} (${signedIn})`);
  return (await portal.devices())
    .filter((device) => !attempt.before.includes(device.id) && device.name === attempt.name)
    .map((device) => device.id);
}

/**
 * The device this attempt created, or undefined if there is none yet (the
 * CLI never collected its token). More than one new device under the
 * attempt's own name is refused rather than guessed.
 */
export async function findAttemptDevice(portal: DevicePortal, attempt: AttemptDevice): Promise<string | undefined> {
  const matches = await newDevicesNamed(portal, attempt);
  if (matches.length > 1) {
    throw new Error(`${matches.length} new devices are named "${attempt.name}"; not guessing which is this attempt's`);
  }
  return matches[0];
}

/**
 * Revokes this attempt's device, however far the attempt got: the id the test
 * recorded, or the one found by the attempt's name. Returns what went wrong,
 * or undefined when the device is revoked or there was none to revoke.
 */
export async function revokeAttemptDevice(
  portal: DevicePortal,
  attempt: AttemptDevice,
  knownId?: string,
): Promise<string | undefined> {
  try {
    const deviceId = knownId ?? (await findAttemptDevice(portal, attempt));
    if (deviceId === undefined) return undefined;
    const signedIn = await portal.signIn(attempt.login);
    if (signedIn !== 200) return `could not sign in as ${attempt.login} to revoke ${deviceId} (${signedIn})`;
    const status = await portal.revoke(deviceId);
    return status === 200 ? undefined : `revoking ${deviceId} returned ${status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
