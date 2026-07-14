export function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix: string, bytes = 8): string {
  return `${prefix}${randomHex(bytes)}`;
}
