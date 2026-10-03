import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@cogworks/contracts/schema";
import { sessionQuery } from "@/lib/queries";
import { Button } from "./Button";
import { LoadingMark, QueryError } from "./Feedback";

/** Login and team are what every cached answer is scoped by. A session
 *  never read is nobody, so it matches no one. */
export function sameAccount(before: Session | undefined, after: Session): boolean {
  if (!before) return false;
  return (
    (before.user?.login ?? null) === (after.user?.login ?? null) &&
    (before.team?.id ?? null) === (after.team?.id ?? null)
  );
}

type Gate = { state: "open" } | { state: "closed" } | { state: "failed"; error: unknown };

const GateContext = createContext<{
  gate: Gate;
  retry: () => void;
  /** Whether a page-level Concealed is showing the gate's status. */
  covered: boolean;
  cover: () => () => void;
}>({
  gate: { state: "open" },
  retry: () => {},
  covered: false,
  cover: () => () => {},
});

/**
 * Closes over account-bound content whenever the document is hidden, and
 * opens again once a fresh session read says who is signed in now.
 *
 * While the page is hidden or frozen in the back/forward cache, another tab
 * can sign in as someone else. The painted tree and the query cache still
 * belong to the first account, and the setup page's commands carry tokens
 * signed for it. The same account gets the same mounted tree back; a
 * different one gets a fresh document.
 *
 * A window that stays visible beside another is never hidden, so blur and
 * focus are treated like hide and return (TanStack Query v5 listens only to
 * visibilitychange). Blur ends what the page knows: a read already in flight
 * can no longer answer for whoever is there at the next focus. Focus conceals
 * at once, before the click or key that brought it can act, and checks with
 * a fresh read. A page left showing while that read ran once accepted a start
 * aimed at a team its label did not name, and an answer requested before a
 * blur once satisfied the focus after it.
 */
export function RestoreGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [gate, setGate] = useState<Gate>({ state: "open" });
  const [covers, setCovers] = useState(0);
  const open = useRef(true);
  const paintedFor = useRef<Session | undefined>(undefined);
  const focused = useRef<Element | null>(null);
  // Any hide or newer check bumps `attempt`, so only the latest check's
  // answer is applied. A cancelled session fetch resolves with the old
  // cached session rather than rejecting, so this is load-bearing.
  const attempt = useRef(0);
  const running = useRef(false);
  // Set by a back/forward-cache restore, whose cached answers may be of any
  // age; a tab that was only hidden keeps its own freshness rules.
  const restored = useRef(false);
  // Set once a reload is requested; nothing reopens this document after that.
  const replacing = useRef(false);
  // Whether focus left since it last arrived; a first read sent before that
  // may carry another account's cookie.
  const blurred = useRef(false);

  const check = useCallback(async () => {
    if (replacing.current) return;
    const mine = ++attempt.current;
    running.current = true;
    setGate((current) => (current.state === "closed" ? current : { state: "closed" }));
    // fetchQuery joins a request already in flight, which may have gone out
    // with the previous account's cookie.
    await qc.cancelQueries({ queryKey: sessionQuery.queryKey, exact: true });
    let session: Session;
    try {
      // "always" because the default pauses a read while the browser reports
      // itself offline, which would hold the gate on its loading mark with
      // no reason given and no retry. Failing shows both.
      session = await qc.fetchQuery({ ...sessionQuery, staleTime: 0, networkMode: "always" });
    } catch (error) {
      if (mine !== attempt.current) return;
      running.current = false;
      setGate({ state: "failed", error });
      return;
    }
    if (mine !== attempt.current) return;
    if (!sameAccount(paintedFor.current, session)) {
      // Clearing the cache in place would leave the old account's pending
      // requests, their callbacks and their timers alive; a new document ends
      // them. Until it commits, a later hide, return or retry must not check
      // again: if the first account signed back in, that check would reveal
      // this page.
      replacing.current = true;
      window.location.reload();
      return;
    }
    if (restored.current) {
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    }
    restored.current = false;
    running.current = false;
    open.current = true;
    setGate({ state: "open" });
  }, [qc]);

  const close = useCallback(() => {
    if (replacing.current) return;
    attempt.current += 1;
    running.current = false;
    if (!open.current) return;
    open.current = false;
    paintedFor.current = qc.getQueryData(sessionQuery.queryKey);
    focused.current = document.activeElement;
    // A modal dialog stays in the top layer when its ancestor is concealed,
    // and it would keep the gate's own retry inert. A confirm left open
    // across a hide is cancelled, not carried to whoever returns.
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
    // Committed before the handler returns, because the back/forward cache
    // freezes whatever the DOM holds at that point.
    flushSync(() => setGate({ state: "closed" }));
  }, [qc]);

  const reopen = useCallback(() => {
    if (open.current) close();
    // pageshow and visibilitychange both announce a restore.
    if (running.current) return;
    void check();
  }, [check, close]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") close();
      else reopen();
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) close();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      restored.current = true;
      reopen();
    };
    const onFocus = () => {
      const returning = blurred.current;
      blurred.current = false;
      if (document.visibilityState !== "visible") return;
      if (!qc.getQueryData(sessionQuery.queryKey)) {
        // Nothing is painted for anyone yet, so there is no account to check
        // against and nothing to conceal. But the first read may still be on
        // the wire with the cookie from before the blur; answered late, it
        // would paint that account under whoever signed in meanwhile. A fresh
        // first read replaces it; the route guards wait for it as usual.
        // A focus with no blur before it (the window taking focus as it
        // loads) has nothing to replace.
        if (returning && qc.isFetching({ queryKey: sessionQuery.queryKey, exact: true }) > 0) {
          void qc
            .cancelQueries({ queryKey: sessionQuery.queryKey, exact: true })
            .then(() => qc.fetchQuery({ ...sessionQuery, staleTime: 0, networkMode: "always" }))
            .catch(() => {}); // a failed read is the guards' to show, with their retry
        }
        return;
      }
      reopen();
    };
    const onBlur = () => {
      blurred.current = true;
      if (replacing.current) return;
      attempt.current += 1;
      running.current = false;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [qc, close, reopen]);

  // Closing blurs whatever was focused inside the hidden tree.
  useEffect(() => {
    if (gate.state !== "open") return;
    const element = focused.current;
    focused.current = null;
    if (
      element instanceof HTMLElement &&
      element.isConnected &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      element.focus({ preventScroll: true });
    }
  }, [gate]);

  const cover = useCallback(() => {
    setCovers((n) => n + 1);
    return () => setCovers((n) => n - 1);
  }, []);

  const value = useMemo(
    () => ({
      gate,
      retry: () => {
        if (!running.current) void check();
      },
      covered: covers > 0,
      cover,
    }),
    [gate, check, covers, cover],
  );

  return (
    <GateContext.Provider value={value}>
      {children}
    </GateContext.Provider>
  );
}

/** Whether the account on screen is known to be the one signed in now. For
 *  account-specific marks on pages that are otherwise public. */
export function useAccountRevealed(): boolean {
  return useContext(GateContext).gate.state === "open";
}

/**
 * Account-bound content under the restore gate. While the gate is closed the
 * children stay mounted but unpainted, inert and hidden from assistive
 * technology, and keep their box so the page neither jumps nor loses its
 * scroll. With `status`, the loading mark or the failure sits over them,
 * pinned to the top of the viewport.
 */
export function Concealed({
  children,
  className = "",
  status = false,
}: {
  children: ReactNode;
  className?: string;
  status?: boolean;
}) {
  const { gate, retry, cover } = useContext(GateContext);
  const closed = gate.state !== "open";
  useEffect(() => (status ? cover() : undefined), [status, cover]);
  const content = (
    <div
      className={closed ? `${className} invisible` : className}
      inert={closed}
      aria-hidden={closed || undefined}
    >
      {children}
    </div>
  );
  if (!status) return content;
  return (
    <div className="relative flex flex-1 flex-col">
      {content}
      {closed && (
        <div className="absolute inset-0">
          <div className="sticky top-0">
            {gate.state === "failed" ? (
              <div className="py-14">
                <QueryError error={gate.error} retry={retry} />
              </div>
            ) : (
              <LoadingMark />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The header's account controls, concealed with the page they belong to.
 * When the session read fails on a page with no status panel of its own (a
 * public page stays readable), the slot offers the retry instead of going
 * blank. On a phone the account slot is too narrow for a sentence, so the
 * retry takes its own row under the header. The button stays mounted through
 * a retry, so keyboard focus is not dropped, and when a retry succeeds focus
 * moves to the account control that replaces it.
 */
export function AccountSlot({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { gate, retry, covered } = useContext(GateContext);
  // Set by a click and cleared once the gate opens, so a later return's
  // ordinary check does not show up here as a retry.
  const [asked, setAsked] = useState(false);
  if (asked && gate.state === "open") setAsked(false);
  const checking = asked && gate.state === "closed";
  const recovering = !covered && (gate.state === "failed" || checking);
  const slot = useRef<HTMLDivElement>(null);
  const retryHadFocus = useRef(false);
  // Runs before the gate's own focus restore, which then sees focus taken.
  // Only when focus went down with the retry: a user who moved elsewhere
  // while it checked keeps their place.
  useEffect(() => {
    if (gate.state !== "open" || !retryHadFocus.current) return;
    retryHadFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    slot.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
  }, [gate.state]);
  return (
    <div
      ref={slot}
      className={`grid items-center justify-items-end *:col-start-1 *:row-start-1 ${
        recovering ? "max-sm:order-last max-sm:w-full max-sm:justify-items-stretch" : ""
      } ${className}`}
    >
      <Concealed className="flex items-center gap-4">{children}</Concealed>
      {recovering && (
        <div className="flex items-center justify-between gap-3 max-sm:border-t max-sm:border-rule-soft max-sm:py-1.5">
          <p id="session-retry-note" role="status" className="text-[12.5px] text-ink-secondary">
            {checking ? "Checking who's signed in…" : "Couldn't check who's signed in."}
          </p>
          <Button
            variant="ghost"
            className="aria-disabled:cursor-progress aria-disabled:text-ink-secondary"
            aria-describedby="session-retry-note"
            aria-disabled={checking || undefined}
            onClick={(event) => {
              if (checking) return;
              retryHadFocus.current = document.activeElement === event.currentTarget;
              setAsked(true);
              retry();
            }}
          >
            {checking ? "Checking" : "Try again"}
          </Button>
        </div>
      )}
    </div>
  );
}
