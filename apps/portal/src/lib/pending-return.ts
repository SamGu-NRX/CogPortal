const STORAGE_KEY = "cogportal.pendingReturn";

/**
 * The only values worth remembering are the two connection-entry URLs that
 * resume a pending link step after sign-in. Checking on read as well as
 * write keeps stale or tampered storage from redirecting the student.
 */
export function isConnectionReturnPath(value: string): boolean {
  return (
    value.startsWith("/connections#discord=") ||
    value.startsWith("/connections?user_code=")
  );
}

function readStoredValue(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Private-mode or blocked storage is not an error worth surfacing, the
    // same call in lib/track.ts treats localStorage this way: the return
    // target just is not remembered across the redirect.
    return null;
  }
}

export function rememberConnectionReturn(value: string): void {
  if (!isConnectionReturnPath(value)) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // See readStoredValue: losing the remembered return is not an error
    // state, the student just lands on the default page after sign-in.
  }
}

export function pendingConnectionReturn(): string | null {
  const value = readStoredValue();
  return value != null && isConnectionReturnPath(value) ? value : null;
}

export function clearConnectionReturn(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is blocked; there was nothing
    // readable to begin with.
  }
}
