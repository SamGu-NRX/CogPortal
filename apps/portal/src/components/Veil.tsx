import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { EASE_IN_OUT, EASE_OUT } from "@/lib/motion";

/**
 * The veil's fade, as variants of whether the latest press skips motion. A
 * leaving element keeps the props of its last render, so a fixed transition
 * would play a pointer's fade after a keyboard press; AnimatePresence hands
 * the leaving veil the current value through `custom` instead.
 */
const VEIL_FADE: Variants = {
  shown: (immediate: boolean) => ({ opacity: 1, transition: { duration: immediate ? 0 : 0.18, ease: EASE_OUT } }),
  hidden: (immediate: boolean) => ({ opacity: 0, transition: { duration: immediate ? 0 : 0.18, ease: EASE_OUT } }),
};

/**
 * Progressive disclosure as tracing paper. The folded-away items are REAL —
 * the top of the next entry stays legible under a translucent, faintly
 * blurred veil, then dissolves toward the toggle. Expanding lifts the paper
 * (veil fades as the list unfolds); collapsing lays it back down. Fully
 * reversible, unlike a one-way "show all".
 *
 * Keyboard: expanding with the keyboard moves focus into the revealed
 * region (via `focusSelector`); the toggle itself never moves, so collapse
 * keeps focus in place. Veiled content is inert + aria-hidden — decorative,
 * never tab-reachable through the clip.
 *
 * Only a pointer gets the motion. A toggle pressed from the keyboard or by
 * assistive technology (a click with `detail` 0: Enter, Space, a screen
 * reader's activate) changes the height and the veil at once, the way
 * reduced motion does: the animation bridges a pointer's jump, and on a
 * keyboard it is only a delay.
 */
export function Veil({
  count,
  moreLabel,
  fewerLabel = "Show fewer",
  detail,
  peek = 52,
  focusSelector,
  children,
}: {
  /** How many items are folded away (renders nothing when 0). */
  count: number;
  /** Toggle label while collapsed, e.g. "See 4 more repositories". */
  moreLabel: string;
  /** Toggle label while expanded. */
  fewerLabel?: string;
  /** Mono sub-line under the toggle label, e.g. "Older repositories · newest first". */
  detail?: string;
  /** Height (px) of legible content peeking above the veil. */
  peek?: number;
  /** CSS selector focused inside the region on keyboard expand. */
  focusSelector?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Whether the latest toggle came from the keyboard or assistive technology.
  const [fromKeyboard, setFromKeyboard] = useState(false);
  const reduceMotion = useReducedMotion();
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);

  if (count <= 0) return <>{children}</>;

  const immediate = reduceMotion || fromKeyboard;
  const duration = immediate ? 0 : open ? 0.24 : 0.2;

  return (
    <div>
      <motion.div
        ref={regionRef}
        id={regionId}
        initial={false}
        animate={{ height: open ? "auto" : peek }}
        transition={{
          duration,
          // Revealing enters the screen (ease-out); folding away morphs in place.
          ease: open ? EASE_OUT : EASE_IN_OUT,
        }}
        className="relative overflow-hidden"
      >
        <div
          aria-hidden={!open}
          // React 19: boolean `inert` — veiled content is never interactive.
          inert={!open}
          className="space-y-2 pt-2"
        >
          {children}
        </div>

        {/* The tracing paper itself: a faint wash + 2px backdrop blur that is
            masked out at the top, so the next entry's first line stays
            readable and dissolves as it approaches the fold. */}
        <AnimatePresence initial={false} custom={immediate}>
          {!open && (
            <motion.div
              key="veil"
              aria-hidden="true"
              custom={immediate}
              variants={VEIL_FADE}
              initial="hidden"
              animate="shown"
              exit="hidden"
              className="pointer-events-none absolute inset-0 bg-paper/45 backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,transparent,black_72%)]"
            />
          )}
        </AnimatePresence>
      </motion.div>

      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={(event) => {
          const next = !open;
          const keyboard = event.detail === 0;
          setFromKeyboard(keyboard);
          setOpen(next);
          if (next && focusSelector && keyboard) {
            requestAnimationFrame(() => {
              regionRef.current
                ?.querySelector<HTMLElement>(focusSelector)
                ?.focus();
            });
          }
        }}
        className={`u-pressable relative flex min-h-12 w-full items-center justify-between gap-4 rounded-control border border-rule bg-paper-raised/85 px-4 py-2.5 text-left backdrop-blur-[3px] transition-colors duration-150 hover:border-ink-secondary hover:bg-paper-raised ${
          open
            ? "mt-2 border-rule-soft"
            : "-mt-px shadow-[0_2px_8px_rgb(27_31_36/0.06)]"
        }`}
      >
        <span>
          <span className="block text-[14px] font-semibold text-ink">
            {open ? fewerLabel : moreLabel}
          </span>
          {detail && (
            <span className="block text-[12.5px] text-ink-faint">
              {detail}
            </span>
          )}
        </span>
        <HugeiconsIcon
          icon={open ? ArrowUp01Icon : ArrowDown01Icon}
          size={16}
          strokeWidth={1.8}
          className="shrink-0 text-ink-faint"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
