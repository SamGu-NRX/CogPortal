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

type TrackSwitcherProps = {
  tracks: Benchmark[];
  benchmark: Benchmark | undefined;
  onSelect: (benchmarkId: string) => void;
  /** Rendered beside the label, e.g. the simulated-provider chip. */
  trailing?: React.ReactNode;
};

/**
 * Which benchmark this page is reading, and how to change it.
 *
 * Two shapes. `menu` is a line of masthead type that opens a popover, for a
 * page where the benchmark is a setting beside the work. `tabs` is a row of
 * notebook index tabs, for a page that is one benchmark's section of the
 * notebook (the Runs page), where every track should be visible and one
 * press away. Both carry the module's color, which is how a student knows at
 * a glance whether they are reading the vision instrument or the language one
 * without a badge on every panel.
 *
 * With a single active benchmark there is no choice to offer. The menu
 * renders as plain text with no trigger; the tabs render nothing.
 */
export function TrackSwitcher(
  props: TrackSwitcherProps & {
    variant?: "menu" | "tabs";
    /** The tabs variant's panel: the element whose content the selected
     *  track decides. It should carry role="tabpanel" and be labelled by
     *  `trackTabId(benchmark.id)`. */
    panelId?: string;
  },
) {
  const { variant = "menu", panelId, ...rest } = props;
  return variant === "tabs" ? (
    <TrackTabs {...rest} panelId={panelId} />
  ) : (
    <TrackMenu {...rest} />
  );
}

/** The id of a track's tab, for the panel's aria-labelledby. */
export function trackTabId(benchmarkId: string): string {
  return `track-tab-${benchmarkId}`;
}

/**
 * Index tabs. The selected one is raised paper that opens into the page below
 * the strip's rule; the others sit flat behind it with their color dimmed.
 *
 * Keyboard follows the ARIA tabs pattern with manual activation: arrows,
 * Home and End move focus, Enter or Space selects. Selecting refetches the
 * whole page for that benchmark, so it should not fire on every arrow press
 * the way automatic activation would. Focus stays on the tab through the
 * load because the strip sits outside the panel that reloads.
 *
 * No motion on switch: it is keyboard-repeatable and the page content
 * changing is the feedback.
 */
function TrackTabs({
  tracks,
  benchmark,
  onSelect,
  panelId,
}: TrackSwitcherProps & { panelId?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedId = benchmark?.id;

  // A phone shows two or three tabs at once, so keep the selected one in
  // view. Scrolls only the strip; scrollIntoView could move the page too.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = left - 8;
    }
  }, [selectedId]);

  if (!benchmark || tracks.length <= 1) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
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
  };

  return (
    <div className="border-b border-rule">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Benchmark track"
        onKeyDown={onKeyDown}
        // Room above for the focus ring; sideways scroll on a phone with the
        // scrollbar hidden, as the header's own tab row does.
        className="-mb-px flex items-stretch gap-1 overflow-x-auto px-px pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tracks.map((track) => {
          const selected = track.id === benchmark.id;
          const accent = MODULE_ACCENT[track.module];
          return (
            <button
              key={track.id}
              id={trackTabId(track.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!selected) onSelect(track.id);
              }}
              // Titles wrap below sm so three tabs fit a phone without the
              // first one scrolling half out of view.
              className={`relative flex min-h-12 max-w-[9.5rem] shrink-0 flex-col items-start justify-end rounded-t-control border px-3 pt-2.5 pb-2 text-left sm:max-w-none sm:px-3.5 transition-colors duration-150 focus-visible:outline-offset-[-2px] ${
                selected
                  ? "z-10 border-rule border-b-paper-raised bg-paper-raised"
                  : "border-transparent hover:bg-ink/[0.04]"
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-x-[-1px] top-[-1px] h-[3px] rounded-t-control ${accent.tick} ${
                  selected ? "" : "opacity-35"
                }`}
              />
              <span className={`text-[12px] leading-tight font-semibold ${accent.text}`}>
                {accent.label}
              </span>
              <span
                className={`text-[14.5px] leading-snug sm:whitespace-nowrap ${
                  selected ? "font-semibold text-ink" : "text-ink-secondary"
                }`}
              >
                {track.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The popover form. Closed, it is one line of masthead type plus a hairline
 * in the module's accent. The open state follows UserMenu: origin-aware
 * scale, 180ms in, 120ms out, no spring, nothing under reduced motion. Rows
 * do not stagger; the popover itself is the reveal, and staggering four rows
 * only makes it feel slower.
 */
function TrackMenu({ tracks, benchmark, onSelect, trailing }: TrackSwitcherProps) {
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
  // The title is words and the version is data, so only the version is mono.
  const label = (
    <>
      <span className="text-[14px] font-semibold">{benchmark.title}</span>
      <span className="u-tnum font-mono text-[12.5px] text-ink-faint">v{benchmark.version}</span>
    </>
  );

  // One track is not a choice. Render what the masthead always rendered.
  if (tracks.length <= 1) {
    return (
      <p className="flex items-baseline gap-2 text-ink-secondary">
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
          <span className="flex items-baseline gap-1.5 text-ink-secondary transition-colors duration-150 group-hover:text-ink">
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
              className={`absolute top-full z-50 mt-2 rounded-surface border border-rule bg-paper-raised py-1.5 shadow-[0_8px_24px_rgb(28_38_55/0.10)] ${
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
                    <span className="u-label">{MODULE_ACCENT[group.module].label}</span>
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
                            ? "bg-paper-sunken/60 focus-visible:bg-paper-sunken"
                            : "hover:bg-paper-sunken focus-visible:bg-paper-sunken"
                        }`}
                      >
                        {checked && (
                          <CornerBrackets
                            size={6}
                            thickness={1}
                            inset={3}
                            // Out of the flex row, or justify-between centers the title.
                            className={`absolute inset-0 ${MODULE_ACCENT[track.module].text}`}
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
              <p className="mt-1 border-t border-rule-soft px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-faint">
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
