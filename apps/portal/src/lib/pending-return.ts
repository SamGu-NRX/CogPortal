const STORAGE_KEY = "cogportal.pendingReturn";

/**
 * The pages a signed-out visitor can be sent to by a link from outside the
 * portal: a device code from `cogworks link`, a Discord link request, and a
 * run or its live console from Discord or the Activity. Anything else is
 * refused, so the stored value can never name another origin (`//host`), a
 * page the sign-in step has no reason to restore, or a path segment like `..`.
 * Run and surface ids are `prefix_hex` (worker/util/id.ts); the optional
 * trailing slash is one the router also matches.
 */
const RETURNABLE = [
  /^\/connections\?user_code=/,
  /^\/connections#discord=/,
  /^\/runs\/[A-Za-z0-9_-]{1,128}\/?$/,
  /^\/run-surfaces\/[A-Za-z0-9_-]{1,128}\/?$/,
];

function returnable(value: string): boolean {
  return RETURNABLE.some((pattern) => pattern.test(value));
}

/**
 * Session storage throws when the browser denies it (some privacy settings
 * and embedded contexts do), on the property read itself. The stage guard
 * touches it on every visit, so a refusal must cost the return, not the page.
 */
function attempt<T>(run: (store: Storage) => T, fallback: T): T {
  try {
    return run(sessionStorage);
  } catch {
    return fallback;
  }
}

/**
 * Saved by the stage guard when it sends a signed-out visitor to /signin. The
 * latest guarded page they asked for is their intent, so a page that is not
 * returnable replaces an older saved link instead of leaving it to win later.
 */
export function rememberReturn(value: string): void {
  attempt((store) => {
    if (returnable(value)) store.setItem(STORAGE_KEY, value);
    else store.removeItem(STORAGE_KEY);
  }, undefined);
}

/** Read by /signin and / once someone is signed in. */
export function pendingReturn(): string | null {
  const value = attempt((store) => store.getItem(STORAGE_KEY), null);
  return value && returnable(value) ? value : null;
}

/**
 * The return exists only to carry a link across sign-in. The stage guard
 * calls this for every signed-in visit, so it is gone by the time the page it
 * named renders, or as soon as the guard sends the visitor to a step they
 * still owe. Keeping it until an approval succeeded made an abandoned or
 * expired code redirect `/` and /signin back to the dead form for the rest of
 * the tab.
 */
export function clearPendingReturn(): void {
  attempt((store) => store.removeItem(STORAGE_KEY), undefined);
}

const DROPPED_KEY = "cogportal.droppedDeviceLink";

/**
 * A student who runs `cogworks link` before joining a team lands on
 * /connections and gets bounced to the step they still owe. What is lost is
 * the browser's way back to the approval page, not the authorization: the
 * browser says nothing and the terminal appears to poll for no reason, but
 * the same code still approves once they return to it. The stage guard
 * records the loss here so the destination page can say what just happened.
 */
export function rememberDroppedDeviceLink(path: string): void {
  if (!path.startsWith("/connections?user_code=") && !path.startsWith("/connections#discord=")) return;
  // Called by the stage guard before its redirect, so denied storage costs
  // the notice and never the redirect.
  attempt((store) => store.setItem(DROPPED_KEY, path.includes("user_code=") ? "device" : "discord"), undefined);
}

/**
 * Read once by the page the guard sent them to. A value that can't be
 * removed is not shown either, or the notice would repeat on every visit.
 */
export function takeDroppedDeviceLink(): "device" | "discord" | null {
  return attempt((store) => {
    const value = store.getItem(DROPPED_KEY);
    if (value !== "device" && value !== "discord") return null;
    store.removeItem(DROPPED_KEY);
    return value;
  }, null);
}
