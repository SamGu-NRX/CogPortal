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
