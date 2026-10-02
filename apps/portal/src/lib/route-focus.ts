import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

const SITE = "Cog*Portal";

/** How long after a navigation a late-rendering heading may still take
 *  focus. Pages render their heading once their data arrives; past this the
 *  user is assumed to have moved on, and focus is left where they put it. */
const FOCUS_WINDOW_MS = 2000;

/**
 * What a page change tells someone who can't see the whole screen.
 *
 * Every page used to share one document title, and a link in the header kept
 * focus after it navigated. So a screen reader announced nothing new, browser
 * tabs and history all read the same, and a keyboard user began each page
 * from the header again.
 *
 * The page's own `<h1>` names it: the title becomes "{heading} · Cog*Portal"
 * and follows the heading if it changes. After a navigation (not the first
 * load), focus moves to that heading, but only when focus is on the page
 * itself or still in the header. A page that put focus somewhere on purpose,
 * such as a run that keeps focus on its console, keeps it.
 */
export function useRouteFocusAndTitle(main: React.RefObject<HTMLElement | null>, header: React.RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  // The pathname the effect last ran for. Only a different one is a
  // navigation: React's development double-run repeats the same pathname,
  // and must not count as one.
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const root = main.current;
    if (!root) return;
    const navigated = previous.current !== null && previous.current !== pathname;
    previous.current = pathname;
    const focusAllowedUntil = navigated ? Date.now() + FOCUS_WINDOW_MS : 0;

    const sync = () => {
      const heading = root.querySelector<HTMLElement>("h1");
      const text = heading?.textContent?.replace(/\s+/g, " ").trim();
      const title = text ? `${text} · ${SITE}` : SITE;
      if (document.title !== title) document.title = title;

      if (!heading || Date.now() > focusAllowedUntil) return;
      const active = document.activeElement;
      const unplaced = !active || active === document.body || Boolean(header.current?.contains(active));
      if (!unplaced) return;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.setAttribute("data-route-heading", "");
      heading.focus({ preventScroll: true });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname, main, header]);
}
