/**
 * What Leave on the Team page just did, held for the page it lands on.
 *
 * Not router state: leaving empties the cached session, and the Team page's
 * stage guard sees that before React Router applies its own navigation (the
 * router's updates run as a transition, the cache's do not). The guard then
 * redirects to /connect with no state of its own, measured as a second
 * replaceState 5 ms after ours, so anything carried in router state is lost.
 * A note held here survives whichever of the two navigations lands last.
 *
 * In memory on purpose: a reload or a later visit to /connect should say
 * nothing, and nothing here is worth keeping across tabs.
 */
export interface LeftTeam {
  name: string;
  /** Nothing was removed: another tab or request had already done it. */
  alreadyLeft: boolean;
}

let pending: LeftTeam | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function rememberLeftTeam(left: LeftTeam): void {
  pending = left;
  changed();
}

/** Idempotent, so StrictMode's second state initializer reads the same note. */
export function peekLeftTeam(): LeftTeam | null {
  return pending;
}

export function clearLeftTeam(): void {
  if (pending === null) return;
  pending = null;
  changed();
}

/** For useSyncExternalStore. A refetched session can redirect to /connect
 *  before the leave request has answered, so the notice may already be
 *  mounted when the note arrives and has to hear about it. */
export function subscribeLeftTeam(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
