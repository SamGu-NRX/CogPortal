import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { InvitableUser } from "@cogworks/contracts/schema";
import { ApiRequestError } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { useAddTeamMember, useInvitableUsers } from "@/lib/queries";
import { MemberAvatar } from "./MemberAvatar";

/**
 * Search-and-add palette for team members. Anchored to its trigger
 * (origin-aware scale, same 180ms in / 120ms out as the account menu), a
 * live filter over cohort students without a team, and a listbox keyboard
 * model: type to filter, arrows to move, Enter to add, Escape to leave.
 * Stays open after an add so a creator can bring the whole team in at once,
 * and says who was added, because the row leaving this list is otherwise the
 * only sign it worked.
 *
 * The GitHub caveat (adding here grants no push access) is said once, beside
 * the team's member list, rather than again in here.
 */
export function MemberPalette({
  open,
  onClose,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const invitable = useInvitableUsers(open);
  const add = useAddTeamMember();
  const reduce = useReducedMotion();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [addingLogin, setAddingLogin] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const all = invitable.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (user) =>
        user.login.toLowerCase().includes(q) ||
        (user.name ?? "").toLowerCase().includes(q),
    );
  }, [invitable.data, query]);

  // Keep the active row inside the filtered list.
  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, candidates.length - 1)));
  }, [candidates.length]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setAdded(null);
    add.reset();
    requestAnimationFrame(() => inputRef.current?.focus());
    const onPointerDown = (e: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open toggles only
  }, [open]);

  const attempt = (user: InvitableUser | undefined) => {
    if (!user || add.isPending) return;
    setAddingLogin(user.login);
    setAdded(null);
    add.mutate(user.login, {
      onSuccess: () => {
        setQuery("");
        setAdded(user.name ?? user.login);
        inputRef.current?.focus();
      },
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, candidates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      attempt(candidates[active]);
    }
  };

  // Tabbing out of the search field leaves the palette, so it closes rather
  // than staying open behind wherever focus went.
  const onBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (rootRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
    onClose();
  };

  const message =
    add.error instanceof ApiRequestError
      ? add.error.message
      : add.error
        ? "That didn't go through. Try adding them again."
        : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={rootRef}
          initial={reduce ? false : { opacity: 0, transform: "translateY(-2px) scale(0.96)" }}
          animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: 0 } }
              : {
                  opacity: 0,
                  transform: "translateY(-2px) scale(0.98)",
                  transition: { duration: 0.12, ease: EASE_OUT },
                }
          }
          transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
          style={{ transformOrigin: "top right" }}
          className="absolute top-full right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-surface border border-rule-strong bg-paper-raised text-left shadow-[0_10px_30px_-8px_rgb(27_31_36/0.22)]"
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          <label className="flex items-center gap-2.5 border-b border-rule px-3.5">
            <HugeiconsIcon
              icon={Search01Icon}
              size={16}
              strokeWidth={1.8}
              className="shrink-0 text-ink-faint"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                candidates[active] ? `${listId}-${candidates[active].login}` : undefined
              }
              aria-label="Search students without a team"
              placeholder="Search the cohort by name or login"
              autoComplete="off"
              spellCheck={false}
              // 16px, or iOS Safari zooms the page into the field.
              className="h-12 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-faint"
            />
          </label>

          <div
            className="max-h-[17rem] overflow-y-auto overscroll-contain py-1"
            role="listbox"
            id={listId}
            aria-label="Students without a team"
          >
            {invitable.isPending ? (
              <p className="px-3.5 py-3 text-[14px] text-ink-secondary">Checking the cohort…</p>
            ) : invitable.isError ? (
              <p className="px-3.5 py-3 text-[14px] text-detect-deep">
                The cohort list didn't load. Close this and open it again.
              </p>
            ) : (invitable.data?.length ?? 0) === 0 ? (
              <p className="px-3.5 py-3 text-[14px] text-ink-secondary">
                Everyone in the cohort already has a team.
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-3.5 py-3 text-[14px] text-ink-secondary">
                No one matches "{query.trim()}".
              </p>
            ) : (
              candidates.map((user, index) => {
                const current = index === active;
                return (
                  <button
                    key={user.login}
                    id={`${listId}-${user.login}`}
                    type="button"
                    role="option"
                    aria-selected={current}
                    tabIndex={-1}
                    disabled={add.isPending}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => attempt(user)}
                    className={`flex min-h-11 w-full items-center gap-3 px-3.5 py-1.5 text-left disabled:opacity-60 ${
                      current ? "bg-paper-sunken" : ""
                    }`}
                  >
                    <MemberAvatar login={user.login} avatarUrl={user.avatarUrl} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-semibold text-ink">
                        {user.name ?? user.login}
                      </span>
                      {user.name && user.name !== user.login && (
                        <span className="block truncate font-mono text-[12px] text-ink-faint">
                          {user.login}
                        </span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 text-[13px] font-semibold ${
                        current ? "text-ink" : "text-ink-faint"
                      }`}
                    >
                      {add.isPending && addingLogin === user.login ? "Adding…" : "Add"}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t border-rule-soft bg-paper px-3.5 py-2.5">
            {message ? (
              <p role="alert" className="text-[13px] leading-snug text-detect-deep">
                {message}
              </p>
            ) : (
              <>
                <p role="status" className={added ? "text-[13px] text-ink" : "sr-only"}>
                  {added ? `Added ${added} to the team.` : ""}
                </p>
                {!added && (
                  // Keys only mean something with a keyboard; a phone gets nothing here.
                  <p className="hidden text-[12.5px] text-ink-faint [@media(pointer:fine)]:block">
                    <Key>↑</Key> <Key>↓</Key> to move, <Key>Enter</Key> to add,{" "}
                    <Key>Esc</Key> to close
                  </p>
                )}
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-[3px] border border-rule-strong bg-paper-raised px-1 font-mono text-[11px] text-ink-secondary">
      {children}
    </kbd>
  );
}
