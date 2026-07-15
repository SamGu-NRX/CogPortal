import type { RunSurfaceAction, RunSurfaceSnapshot } from "@cogworks/contracts/schema";

/**
 * Button policy for the public run surface: one decision per message.
 * While running there are no buttons at all (the Watch-live accessory is the
 * only control). At terminal, at most two action buttons plus the portal
 * link: the stage's primary action first, then one quiet secondary.
 */

export interface SurfaceButtonSpec {
  action: Exclude<RunSurfaceAction, "open_console" | "open_portal">;
  label: string;
  /** 1 primary, 2 secondary. Danger belongs to confirm dialogs, not here. */
  style: 1 | 2;
}

const PRIMARY_ORDER = ["publish_result", "promote_official", "verify_hosted"] as const;
const SECONDARY_ORDER = ["rerun_hosted", "run_again"] as const;

const LABELS: Record<SurfaceButtonSpec["action"], string> = {
  publish_result: "Publish result",
  promote_official: "Promote to official",
  verify_hosted: "Verify hosted",
  rerun_hosted: "Rerun hosted",
  run_again: "Run again",
};

export function terminalButtons(snapshot: RunSurfaceSnapshot): SurfaceButtonSpec[] {
  const available = new Set(snapshot.actions);
  const buttons: SurfaceButtonSpec[] = [];
  const primary = PRIMARY_ORDER.find((action) => available.has(action));
  if (primary) buttons.push({ action: primary, label: LABELS[primary], style: 1 });
  const secondary = SECONDARY_ORDER.find((action) => available.has(action));
  if (secondary) buttons.push({ action: secondary, label: LABELS[secondary], style: 2 });
  return buttons;
}

export function watchLiveAvailable(snapshot: RunSurfaceSnapshot): boolean {
  return snapshot.status === "running" && snapshot.actions.includes("open_console");
}
