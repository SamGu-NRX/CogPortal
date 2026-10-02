import { useLayoutEffect, useRef, type FocusEvent } from "react";

/**
 * For a region whose controls are replaced by the result of pressing them: a
 * confirm that becomes "Published", a launcher that becomes the live run.
 * When the element that last held focus inside the region leaves the
 * document while focused, and focus has fallen to the page, focus moves to
 * `fallback` instead of leaving a keyboard user at the top.
 *
 * Focus the user moved away themselves is left alone. A blur whose element
 * is still in the document afterwards was a real move (a click on text, a
 * Tab out), so the region forgets it; a blur caused by removal leaves the
 * element disconnected, and that is the case this exists for.
 *
 * Spread the returned handlers on the region's root. The check runs after
 * every commit because any refetch can be the one that removes the control.
 */
export function useFocusFallback(fallback: () => HTMLElement | null | undefined) {
  const lastFocused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const last = lastFocused.current;
    if (!last || last.isConnected) return;
    lastFocused.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    fallback()?.focus();
  });
  return {
    onFocus: (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) lastFocused.current = event.target;
    },
    onBlur: (event: FocusEvent) => {
      const left = event.target;
      queueMicrotask(() => {
        if (lastFocused.current === left && left.isConnected) lastFocused.current = null;
      });
    },
  };
}
