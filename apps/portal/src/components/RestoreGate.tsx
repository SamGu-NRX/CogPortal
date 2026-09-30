import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@cogworks/contracts/schema";
import { sessionQuery } from "@/lib/queries";
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

/** Resolves once no mutation is pending. A mutation sent before the switch
 *  still runs its onSuccess, which can write the previous account's answer
 *  into a shared cache entry, so the cache is cleared only after that. */
function mutationsSettled(qc: QueryClient): Promise<void> {
  const cache = qc.getMutationCache();
  const pending = () => cache.getAll().some((mutation) => mutation.state.status === "pending");
  if (!pending()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = cache.subscribe(() => {
      if (pending()) return;
      unsubscribe();
      resolve();
    });
  });
}

type Gate = { state: "open" } | { state: "closed" } | { state: "failed"; error: unknown };

const GateContext = createContext<{ gate: Gate; retry: () => void }>({
  gate: { state: "open" },
  retry: () => {},
});

/**
 * Closes over account-bound content whenever the document is hidden, and
 * opens again once a fresh session read says who is signed in now.
 *
 * While the page is hidden or frozen in the back/forward cache, another tab
 * can sign in as someone else. The painted tree and the query cache still
 * belong to the first account, and the setup page's commands carry tokens
 * signed for it. The same account gets the same mounted tree back; a
 * different one gets an empty cache and a fresh tree.
 */
export function RestoreGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [gate, setGate] = useState<Gate>({ state: "open" });
  const [tree, setTree] = useState(0);
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

  const check = useCallback(async () => {
    const mine = ++attempt.current;
    running.current = true;
    setGate((current) => (current.state === "closed" ? current : { state: "closed" }));
    // fetchQuery joins a request already in flight, which may have gone out
    // with the previous account's cookie.
    await qc.cancelQueries({ queryKey: sessionQuery.queryKey, exact: true });
    let session: Session;
    try {
      session = await qc.fetchQuery({ ...sessionQuery, staleTime: 0 });
    } catch (error) {
      if (mine !== attempt.current) return;
      running.current = false;
      setGate({ state: "failed", error });
      return;
    }
    if (mine !== attempt.current) return;
    const notSession = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "session" };
    if (!sameAccount(paintedFor.current, session)) {
      await mutationsSettled(qc);
      if (mine !== attempt.current) return;
      // Removing a query also drops a response still on the wire for it.
      qc.removeQueries(notSession);
      setTree((n) => n + 1);
    } else if (restored.current) {
      void qc.invalidateQueries(notSession);
    }
    restored.current = false;
    running.current = false;
    open.current = true;
    setGate({ state: "open" });
  }, [qc]);

  const close = useCallback(() => {
    attempt.current += 1;
    running.current = false;
    if (!open.current) return;
    open.current = false;
    paintedFor.current = qc.getQueryData(sessionQuery.queryKey);
    focused.current = document.activeElement;
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
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [close, reopen]);

  // Closing blurs whatever was focused inside the hidden tree. A remounted
  // tree has no such element, which isConnected catches.
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

  const value = useMemo(
    () => ({
      gate,
      retry: () => {
        if (!running.current) void check();
      },
    }),
    [gate, check],
  );

  return (
    <GateContext.Provider value={value}>
      <Fragment key={tree}>{children}</Fragment>
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
  const { gate, retry } = useContext(GateContext);
  const closed = gate.state !== "open";
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
