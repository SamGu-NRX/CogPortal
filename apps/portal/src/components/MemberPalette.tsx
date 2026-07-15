import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { InvitableUser } from "@cogworks/contracts/schema";
import { ApiRequestError } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { useAddTeamMember, useInvitableUsers } from "@/lib/queries";

/**
 * Search-and-add palette for team members. Anchored to its trigger
 * (origin-aware scale, same 180ms in / 120ms out as the account menu), a
 * live filter over cohort students without a team, and a listbox keyboard
 * model: type to filter, arrows to move, Enter to add, Escape to leave.
 * Stays open after an add so a creator can bring the whole team in at once.
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
    add.mutate(user.login, {
      onSuccess: () => {
        setQuery("");
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

  const message =
    add.error instanceof ApiRequestError
      ? add.error.message
      : add.error
        ? "Adding failed. Try again."
        : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={rootRef}
          initial={reduce ? false : { opacity: 0, scale: 0.95, y: -2 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, scale: 0.97, y: -2, transition: { duration: 0.12, ease: EASE_OUT } }
          }
          transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
          style={{ transformOrigin: "top right" }}
          className="absolute top-full right-0 z-20 mt-2 w-[min(20rem,90vw)] border border-rule bg-paper-raised shadow-[0_6px_24px_rgb(28_38_55/0.12)]"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-rule-soft px-3">
            <HugeiconsIcon
              icon={Search01Icon}
              size={14}
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
              placeholder="Search the cohort"
              autoComplete="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          <div className="max-h-64 overflow-y-auto" role="listbox" id={listId} aria-label="Students without a team">
            {invitable.isPending ? (
              <p className="px-3 py-3 text-[12.5px] text-ink-faint">Checking the cohort…</p>
            ) : invitable.isError ? (
              <p className="px-3 py-3 text-[12.5px] text-detect-deep">
                Couldn't load the cohort. Close this and try again.
              </p>
            ) : (invitable.data?.length ?? 0) === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-ink-faint">
                Everyone in the cohort already has a team.
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-ink-faint">
                No one matches "{query.trim()}".
              </p>
            ) : (
              candidates.map((user, index) => (
                <button
                  key={user.login}
                  id={`${listId}-${user.login}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  disabled={add.isPending}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => attempt(user)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 ${
                    index === active ? "bg-paper-sunken" : ""
                  } disabled:opacity-60`}
                >
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="size-5 rounded-[2px]" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-5 items-center justify-center border border-rule bg-paper-sunken font-mono text-[9px] text-ink-secondary uppercase"
                    >
                      {user.login[0]}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                    {user.login}
                    {user.name && <span className="ml-2 text-ink-faint">{user.name}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
                    {add.isPending && addingLogin === user.login ? "adding…" : "add"}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-rule-soft px-3 py-2">
            {message ? (
              <p role="alert" className="text-[11.5px] leading-snug text-detect-deep">
                {message}
              </p>
            ) : (
              <p className="text-[11px] leading-snug text-ink-faint">
                Adding someone here doesn't touch GitHub. Invite them as a
                collaborator on the fork too, so they can push.
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
