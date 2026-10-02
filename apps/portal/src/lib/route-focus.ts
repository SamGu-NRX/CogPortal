import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

const SITE = "Cog*Portal";

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
 * load), focus moves to that heading once, as soon as it renders, while
 * focus is still on the page itself or in the header. The move is dropped if
 * the user presses a key or the pointer first, or if the page puts focus
 * somewhere in it, such as a run that keeps focus on its console.
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

    // One move per navigation, and only until someone else decides where
    // focus goes. A refetch after the move must never pull focus back.
    let pending = navigated;
    const cancel = () => {
      pending = false;
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && root.contains(target) && target !== root.querySelector("h1")) cancel();
    };
    if (pending) {
      document.addEventListener("keydown", cancel, true);
      document.addEventListener("pointerdown", cancel, true);
      document.addEventListener("focusin", onFocusIn, true);
    }

    const sync = () => {
      const heading = root.querySelector<HTMLElement>("h1");
      const text = heading?.textContent?.replace(/\s+/g, " ").trim();
      const title = text ? `${text} · ${SITE}` : SITE;
      if (document.title !== title) document.title = title;

      if (!pending || !heading) return;
      const active = document.activeElement;
      const unplaced = !active || active === document.body || Boolean(header.current?.contains(active));
      pending = false;
      if (!unplaced) return;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.setAttribute("data-route-heading", "");
      heading.focus({ preventScroll: true });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [pathname, main, header]);
}
