/**
 * The device approval a student opened before they had a team, kept so Setup
 * can offer it again once they've joined one.
 *
 * Separate from the sign-in return (pending-return.ts) on purpose. That one is
 * navigated to automatically and cleared on every signed-in visit, because
 * keeping it sent an abandoned or expired code's dead form back through `/`
 * and /signin for the rest of the tab. This one is never navigated to: Setup
 * only offers it as a link, and only after the status endpoint says the code
 * is still open and unapproved. So it can outlive the onboarding steps
 * without bringing that loop back.
 *
 * Tab-local (session storage) and bound to the account that opened it: a
 * different account signed in on the same tab never sees it.
 */

const KEY = "cogportal.heldDeviceLink";

/** The approval path the CLI prints, relative and nothing else (worker/routes/connections.ts, verificationUri). */
const APPROVAL_PATH = /^\/connections\?user_code=([A-Za-z0-9-]{1,64})(?:&return_to=setup)?$/;

export type HeldDeviceLink = {
  /** Relative path of the approval page, as the guard saw it. */
  readonly path: string;
  /** The device code in it, upper-cased as the approval page shows it. */
  readonly userCode: string;
  /** The account that opened it. */
  readonly login: string;
};

/**
 * Session storage throws when the browser denies it, on the property read
 * itself. Losing the offer is acceptable; losing the page is not. (The same
 * guard as pending-return.ts, kept local so that module stays as it is.)
 */
function attempt<T>(run: (store: Storage) => T, fallback: T): T {
  try {
    return run(sessionStorage);
  } catch {
    return fallback;
  }
}

function parse(path: string, login: string): HeldDeviceLink | null {
  const match = APPROVAL_PATH.exec(path);
  if (!match || !login) return null;
  // SAFETY: the pattern's one capture group is mandatory.
  return { path, userCode: match[1]!.toUpperCase(), login };
}

/** Called by the stage guard as it sends a teamless account away from an approval page. Anything else is ignored. */
export function holdDeviceLink(path: string, login: string): void {
  const held = parse(path, login);
  if (!held) return;
  attempt((store) => store.setItem(KEY, JSON.stringify(held)), undefined);
}

/** The stored value, checked again as if the guard had just seen it; the stored code is not trusted. */
function readStored(raw: string): HeldDeviceLink | null {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  return stored && typeof stored === "object" && "path" in stored && "login" in stored &&
    typeof stored.path === "string" && typeof stored.login === "string"
    ? parse(stored.path, stored.login)
    : null;
}

/**
 * The held link if it belongs to `login`. A stored value that doesn't parse,
 * or that another account opened, is removed rather than returned.
 */
export function heldDeviceLink(login: string): HeldDeviceLink | null {
  return attempt((store) => {
    const raw = store.getItem(KEY);
    if (raw === null) return null;
    const held = readStored(raw);
    if (!held || held.login !== login) {
      store.removeItem(KEY);
      return null;
    }
    return held;
  }, null);
}

/**
 * Forgets a link another account held, once `login` is the signed-in account
 * (HeldDeviceLinkAccountCheck runs it on every page), so switching accounts
 * in a tab discards it even if the other account never opens Setup.
 */
export function forgetHeldDeviceLinkUnlessFor(login: string): void {
  heldDeviceLink(login);
}

/**
 * Forgets the held link, but only if it is still this code: an answer about
 * an older code that arrives after a newer link was held must not erase it.
 * A value that doesn't parse has nothing to protect, so it goes too.
 */
export function releaseHeldDeviceLink(userCode: string): void {
  attempt((store) => {
    const raw = store.getItem(KEY);
    if (raw === null) return;
    const held = readStored(raw);
    if (held && held.userCode !== userCode.toUpperCase()) return;
    store.removeItem(KEY);
  }, undefined);
}
