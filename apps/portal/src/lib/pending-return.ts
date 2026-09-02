const STORAGE_KEY = "cogportal.pendingReturn";

export function rememberConnectionReturn(value: string): void {
  if (value.startsWith("/connections#discord=") || value.startsWith("/connections?user_code=")) {
    sessionStorage.setItem(STORAGE_KEY, value);
  }
}

export function pendingConnectionReturn(): string | null {
  const value = sessionStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  return value.startsWith("/connections#discord=") || value.startsWith("/connections?user_code=")
    ? value
    : null;
}

export function clearConnectionReturn(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

const DROPPED_KEY = "cogportal.droppedDeviceLink";

/**
 * A student who runs `cogworks link` before joining a team lands on
 * /connections, gets bounced to the step they still owe, and the code dies
 * silently: the browser says nothing and the terminal polls until it expires.
 * The stage guard records the loss here so the destination page can say what
 * just happened.
 */
export function rememberDroppedDeviceLink(path: string): void {
  if (path.startsWith("/connections?user_code=") || path.startsWith("/connections#discord=")) {
    sessionStorage.setItem(DROPPED_KEY, path.includes("user_code=") ? "device" : "discord");
    // The return that sign-in saved for this same link. Dropping the link
    // and keeping its return sent a student who had since made a team back
    // to a dead device code from `/` and `/signin`, with no way to clear it.
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export function takeDroppedDeviceLink(): "device" | "discord" | null {
  const value = sessionStorage.getItem(DROPPED_KEY);
  if (value !== "device" && value !== "discord") return null;
  sessionStorage.removeItem(DROPPED_KEY);
  return value;
}
