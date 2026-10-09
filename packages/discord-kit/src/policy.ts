import type { RunSurfaceAction, RunSurfaceSnapshot } from "@cogworks/contracts/schema";

/**
 * Button policy for the public run surface: one decision per message.
 * While running there are no buttons at all (the Watch-live accessory is the
 * only control). At terminal, at most two action buttons plus the portal
 * link: the stage's primary action first, then one quiet secondary.
 */

/** Snapshot statuses where action buttons exist: "succeeded", "failed"
 *  and "cancelled", the terminal statuses of RunSurfaceSnapshot. */
export type TerminalStatus = Exclude<RunSurfaceSnapshot["status"], "running">;

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

export function terminalButtons(snapshot: RunSurfaceSnapshot): readonly SurfaceButtonSpec[] {
  // The module doc promises no buttons while a run is still going.
  // "running" is the only non-terminal status a snapshot can carry; the
  // contract tests pin that set, so a new status fails them first.
  if (snapshot.status === "running") {
    throw new TypeError(
      `terminalButtons: snapshot is not terminal (status "${snapshot.status}"); render buttons only for terminal snapshots.`,
    );
  }
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
