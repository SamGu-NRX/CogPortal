import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Benchmark, Module } from "@cogworks/contracts/schema";
import { EASE_OUT } from "@/lib/motion";
import { MODULE_ACCENT } from "@/lib/track";
import { CornerBrackets } from "./Brackets";

const MENU_WIDTH = 18 * 16;
const VIEWPORT_GUTTER = 16;

/**
 * Which benchmark this page is reading, and how to change it.
 *
 * Closed, it is the same line of masthead type the dashboard always showed,
 * plus a hairline in the module's accent. That rule is the only new visual
 * idea here and it earns its place: it is how a student knows at a glance
 * whether they are looking at the vision instrument or the language one,
 * without a badge on every panel.
 *
 * With a single active benchmark there is no choice to offer, so the control
 * renders as plain text with no trigger, no chevron, and no accent. A cohort
 * running one module sees exactly what it saw before.
 *
 * The open state follows UserMenu: origin-aware scale, 180ms in, 120ms out,
 * no spring, nothing under reduced motion. Rows do not stagger; the popover
 * itself is the reveal, and staggering four rows only makes it feel slower.
 */
export function TrackSwitcher({
  tracks,
  benchmark,
  onSelect,
  trailing,
}: {
  tracks: Benchmark[];
  benchmark: Benchmark | undefined;
  onSelect: (benchmarkId: string) => void;
  /** Rendered beside the label, e.g. the simulated-provider chip. */
  trailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [alignLeft, setAlignLeft] = useState(false);
  const [menuWidth, setMenuWidth] = useState(MENU_WIDTH);

  const updateMenuAlignment = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const viewportWidth = document.documentElement.clientWidth;
    const availableMenuWidth = Math.min(
      MENU_WIDTH,
      viewportWidth - VIEWPORT_GUTTER * 2,
    );
    setMenuWidth(availableMenuWidth);
    setAlignLeft(
      trigger.getBoundingClientRect().right - availableMenuWidth < VIEWPORT_GUTTER,
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuAlignment();
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
        );
        if (items.length === 0) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "ArrowDown"
            ? items[(index + 1) % items.length]
            : items[(index - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updateMenuAlignment);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updateMenuAlignment);
    };
  }, [open, updateMenuAlignment]);

  // Focus the checked row so the keyboard lands where the eye does.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const menu = menuRef.current;
      const checked = menu?.querySelector<HTMLElement>('[aria-checked="true"]');
      (checked ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    });
  }, [open]);

  if (!benchmark) return null;

  const accent = MODULE_ACCENT[benchmark.module];
  const label = `${benchmark.title} · v${benchmark.version}`;

  // One track is not a choice. Render what the masthead always rendered.
  if (tracks.length <= 1) {
    return (
      <p className="flex items-baseline gap-2 font-mono text-[11.5px] tracking-[0.05em] text-ink-secondary">
        {label}
        {trailing}
      </p>
    );
  }

  const groups: Array<{ module: Module; items: Benchmark[] }> = [];
  for (const track of tracks) {
    const last = groups[groups.length - 1];
    if (last && last.module === track.module) last.items.push(track);
    else groups.push({ module: track.module, items: [track] });
  }

  return (
    <div className="flex items-baseline gap-2">
      <div ref={rootRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="track-menu"
          onClick={() => {
            if (!open) updateMenuAlignment();
            setOpen((value) => !value);
          }}
          className="u-pressable group relative flex flex-col items-end gap-1 pt-1 after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']"
        >
          <span className="flex items-baseline gap-1.5 font-mono text-[11.5px] tracking-[0.05em] text-ink-secondary transition-colors duration-150 group-hover:text-ink">
            {label}
            <motion.span
              aria-hidden="true"
              animate={{ rotate: open ? 180 : 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
              className="self-center text-ink-faint"
            >
              <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} />
            </motion.span>
          </span>
          {/* The module tell. Same weight as the leaderboard's track rule. */}
          <span aria-hidden="true" className={`h-0.5 w-full ${accent.tick}`} />
          <span className="sr-only">
            Change benchmark track. Currently {benchmark.title}.
          </span>
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              ref={menuRef}
              id="track-menu"
              role="menu"
              aria-label="Benchmark track"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={
                reduce
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: "easeOut" } }
              }
              transition={{ duration: 0.18, ease: EASE_OUT }}
              style={{
                transformOrigin: alignLeft ? "top left" : "top right",
                width: menuWidth,
              }}
              className={`absolute top-full z-50 mt-2 border border-rule bg-paper-raised py-1.5 shadow-[0_8px_24px_rgb(28_38_55/0.10)] ${
                alignLeft ? "left-0" : "right-0"
              }`}
            >
              {groups.map((group, groupIndex) => (
                <div key={group.module}>
                  {/* Extra air above later groups so a selected row's corner
                      brackets never crowd the heading of its own module. */}
                  <div
                    className={`flex items-center gap-2 px-3 pb-1.5 ${
                      groupIndex === 0 ? "pt-1.5" : "pt-3.5"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2.5 w-0.5 ${MODULE_ACCENT[group.module].tick}`}
                    />
                    <span className="u-kicker">{MODULE_ACCENT[group.module].label}</span>
                  </div>
                  {group.items.map((track) => {
                    const checked = track.id === benchmark.id;
                    return (
                      <button
                        key={track.id}
                        role="menuitemradio"
                        aria-checked={checked}
                        type="button"
                        tabIndex={-1}
                        onClick={() => {
                          onSelect(track.id);
                          setOpen(false);
                          triggerRef.current?.focus();
                        }}
                        className={`relative flex min-h-11 w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none ${
                          checked
                            ? "bg-paper-sunken/60"
                            : "hover:bg-paper-sunken focus-visible:bg-paper-sunken"
                        }`}
                      >
                        {checked && (
                          <CornerBrackets
                            size={6}
                            thickness={1}
                            inset={3}
                            className={MODULE_ACCENT[track.module].text}
                          />
                        )}
                        <span
                          className={`text-[13.5px] ${checked ? "font-medium text-ink" : "text-ink-secondary"}`}
                        >
                          {track.title}
                        </span>
                        <span className="u-tnum shrink-0 font-mono text-[11px] text-ink-faint">
                          v{track.version}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              <p className="mt-1 border-t border-rule-soft px-3 pt-2 pb-1 font-mono text-[10.5px] leading-relaxed text-ink-faint">
                Each track keeps its own runs and attempts.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {trailing}
    </div>
  );
}
