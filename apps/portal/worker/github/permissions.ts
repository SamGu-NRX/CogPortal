export type TeamRole = "admin" | "maintain" | "write";

export function teamRole(permission: string): TeamRole | null {
  if (permission === "admin" || permission === "maintain" || permission === "write") {
    return permission;
  }
  return permission === "push" ? "write" : null;
}
