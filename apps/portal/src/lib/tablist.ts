import type { KeyboardEvent } from "react";

/**
 * Arrow keys, Home and End move focus between the tabs of the tablist the
 * handler sits on; Enter or Space (the tab's own button behavior) selects.
 * Manual activation, so moving through the tabs never refetches a board.
 * Pair it with a roving tabindex: the selected tab is 0, the rest -1.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return;
  event.preventDefault();
  const index = tabs.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? tabs[0]
      : event.key === "End"
        ? tabs[tabs.length - 1]
        : event.key === "ArrowRight"
          ? tabs[(index + 1) % tabs.length]
          : tabs[(index - 1 + tabs.length) % tabs.length];
  next?.focus();
}
