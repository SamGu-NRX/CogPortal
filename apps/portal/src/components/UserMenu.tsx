import {
  ArrowDown01Icon,
  CrownIcon,
  DashboardSquare01Icon,
  LinkSquare01Icon,
  Logout02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { Session } from "@cogworks/contracts/schema";
import { useAccountRevealed } from "@/components/RestoreGate";
import { firstName } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import { useLogout } from "@/lib/queries";
import { canOpenAdmin } from "@/lib/roles";

type IconType = typeof DashboardSquare01Icon;

/**
 * Header account menu: what belongs to the person rather than the team. The
 * team's own pages are tabs in the header (components/Shell.tsx), so the menu
 * only repeats a way forward for a student who has no team yet. Staff without
 * a team get neither that nor Connections: Admin is their way forward, already
 * a header tab, and linking Discord or a device needs a team to act on.
 *
 * Origin-aware scale from the trigger, 180ms ease-out in and 120ms out, no
 * spring, instant under reduced motion. Full menu-button keyboard behavior.
 */
export function UserMenu({
  user,
  hasTeam,
  nextPath,
  teamName = null,
}: {
  user: NonNullable<Session["user"]>;
  hasTeam: boolean;
  nextPath: string;
  teamName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const staffWithoutTeam = !hasTeam && canOpenAdmin(user);
  // A concealed menu is inert, but its document key handler is not, so an
  // open menu would keep swallowing arrow keys on the page behind it.
  const revealed = useAccountRevealed();
  if (open && !revealed) setOpen(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  // Close on route change (Shell persists across routes, so exits still play).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
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
          menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
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
    // Tab out of the menu closes it, so its arrow keys stop answering for
    // whatever control has focus next. Checked a frame later, because focus
    // passes through the body while it moves between two items.
    const root = rootRef.current;
    let frame = 0;
    const onFocusOut = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (focused && focused !== document.body && !root?.contains(focused)) setOpen(false);
      });
    };
    root?.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      root?.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;

      // Match TrackSwitcher's viewport gutter; the header can wrap at either side.
      const gutter = 16;
      const viewportWidth = document.documentElement.clientWidth;
      menu.style.maxWidth = `${viewportWidth - gutter * 2}px`;
      const anchor = root.getBoundingClientRect();
      const width = menu.offsetWidth;
      const preferredLeft = anchor.right - width < gutter ? anchor.left : anchor.right - width;
      const left = Math.max(gutter, Math.min(preferredLeft, viewportWidth - width - gutter));
      menu.style.right = `${anchor.right - left - width}px`;
      menu.style.transformOrigin = `${anchor.right - left}px top`;
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    return () => window.removeEventListener("resize", placeMenu);
  }, [open]);

  // Focus the first item once the menu is on screen.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      });
    }
  }, [open]);

  const itemClass =
    "flex min-h-10 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[14px] font-medium text-ink-secondary transition-colors duration-150 hover:bg-paper-sunken hover:text-ink focus-visible:bg-paper-sunken focus-visible:text-ink focus-visible:-outline-offset-2";

  const MenuLink = ({ to, icon, label }: { to: string; icon: IconType; label: string }) => (
    <Link role="menuitem" to={to} className={itemClass} tabIndex={-1}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} aria-hidden="true" />
      {label}
    </Link>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="user-menu"
        onClick={() => setOpen((v) => !v)}
        className="u-pressable flex min-h-11 items-center gap-2 px-1"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-7 rounded-full ring-1 ring-rule" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-full bg-ink text-[12px] font-bold text-paper-raised uppercase"
          >
            {user.login[0]}
          </span>
        )}
        <span className="hidden items-center gap-1.5 text-[14px] font-semibold text-ink sm:flex">
          <span>{firstName(user.name, user.login)}</span>
          {user.isOwner ? (
            <span
              role="img"
              aria-label="CogPortal owner"
              title="CogPortal owner"
              className="text-ochre"
            >
              <HugeiconsIcon icon={CrownIcon} size={15} strokeWidth={1.9} aria-hidden="true" />
            </span>
          ) : null}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
          className="text-ink-faint"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
        </motion.span>
        <span className="sr-only">Account menu for {user.login}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id="user-menu"
            role="menu"
            aria-label="Account"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0 } }
                : { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: "easeOut" } }
            }
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="absolute top-full right-0 z-50 mt-2 w-52 rounded-surface border border-rule bg-paper-raised p-1.5 shadow-[0_10px_30px_-6px_rgb(27_31_36/0.18),0_2px_6px_rgb(27_31_36/0.06)]"
          >
            {/* Who is signed in, said once in words, since the trigger only
                shows an initial on a phone. Not a menu item. */}
            <div className="px-2.5 pt-1.5 pb-2">
              <p className="truncate text-[14px] font-semibold text-ink">{user.login}</p>
              {teamName && <p className="truncate text-[13px] text-ink-secondary">{teamName}</p>}
            </div>
            <div role="separator" className="mb-1.5 border-t border-rule-soft" />
            {!hasTeam && !staffWithoutTeam && (
              <MenuLink to={nextPath} icon={DashboardSquare01Icon} label="Continue setup" />
            )}
            {!staffWithoutTeam && (
              <>
                <MenuLink to="/connections" icon={LinkSquare01Icon} label="Connections" />
                <div role="separator" className="my-1.5 border-t border-rule-soft" />
              </>
            )}
            <button
              role="menuitem"
              type="button"
              tabIndex={-1}
              onClick={() =>
                logout.mutate(undefined, { onSuccess: () => navigate("/") })
              }
              className={itemClass}
            >
              <HugeiconsIcon icon={Logout02Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
