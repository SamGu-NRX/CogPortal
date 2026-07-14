import {
  ArrowDown01Icon,
  DashboardSquare01Icon,
  LinkSquare01Icon,
  Logout02Icon,
  Settings01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { Session } from "@cogworks/contracts/schema";
import { firstName } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import { useLogout } from "@/lib/queries";

type IconType = typeof DashboardSquare01Icon;

/**
 * Header account menu. Origin-aware scale from the trigger (Emil tip #5),
 * 180ms ease-out in / 120ms out, no spring — and instant under reduced
 * motion. Full menu-button keyboard behavior.
 */
export function UserMenu({
  user,
  hasTeam,
  isStaff,
  nextPath,
}: {
  user: NonNullable<Session["user"]>;
  hasTeam: boolean;
  isStaff: boolean;
  nextPath: string;
}) {
  const [open, setOpen] = useState(false);
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
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
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
    "flex w-full items-center gap-2.5 px-3 py-2 text-left font-mono text-[12px] text-ink-secondary transition-colors duration-150 hover:bg-paper-sunken hover:text-ink focus-visible:bg-paper-sunken focus-visible:text-ink focus-visible:outline-none";

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
          <img src={user.avatarUrl} alt="" className="size-6 rounded-[2px]" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center border border-rule bg-paper-sunken font-mono text-[10px] text-ink-secondary uppercase"
          >
            {user.login[0]}
          </span>
        )}
        <span className="hidden font-mono text-[12px] text-ink sm:inline">
          {firstName(user.name, user.login)}
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
            style={{ transformOrigin: "top right" }}
            className="absolute top-full right-0 z-50 mt-2 w-52 border border-rule bg-paper-raised py-1 shadow-[0_8px_24px_rgb(28_38_55/0.10)]"
          >
            {hasTeam ? (
              <>
                <MenuLink to="/dashboard" icon={DashboardSquare01Icon} label="Dashboard" />
                <MenuLink to="/team" icon={Settings01Icon} label="Team settings" />
              </>
            ) : (
              <MenuLink to={nextPath} icon={DashboardSquare01Icon} label="Continue setup" />
            )}
            <MenuLink to="/connections" icon={LinkSquare01Icon} label="Connections" />
            {isStaff && <MenuLink to="/admin" icon={UserGroupIcon} label="Admin" />}
            <div role="separator" className="my-1 border-t border-rule-soft" />
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
