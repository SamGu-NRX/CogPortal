import { useEffect, useReducer, useRef, useState } from "react";
import { Link } from "react-router";
import { buttonClass } from "@/components/Button";
import { useFocusFallback } from "@/lib/focus";
import {
  forgetHeldDeviceLinkUnlessFor,
  heldDeviceLink,
  releaseHeldDeviceLink,
  type HeldDeviceLink,
} from "@/lib/held-device-link";
import { useDeviceLinkStatus, useSession } from "@/lib/queries";
import { deviceLinkCommand } from "@/lib/setup-progress";

/**
 * Offers the device approval a student opened before they had a team, once
 * they have one. Nothing happens on its own: the card is a link to the same
 * approval page, which shows the code and needs its button.
 *
 * Only what the server says is shown. The status endpoint knows the code is
 * still open and unapproved; it can't know whether the terminal that printed
 * it is still running, so the copy never says it is.
 *
 * - open and unapproved: the card, until the code's deadline
 * - expired, consumed or already approved: nothing, and this code's held
 *   link is forgotten
 * - no answer yet, or the check failed: nothing, and the held link is kept,
 *   because a failed check is not an expired code
 *
 * At the deadline the card goes without asking again. Only the server's
 * answer forgets the link, and the next visit's own check gets that answer.
 *
 * It sits below Setup's heading rather than with the arrival note above it:
 * a navigation puts focus on the heading, and reading or tabbing on from
 * there has to reach the offer.
 */
export function HeldDeviceLinkOffer({ login }: { login: string }) {
  const [held, setHeld] = useState(() => heldDeviceLink(login));
  const [dismissed, setDismissed] = useState(false);
  const status = useDeviceLinkStatus(held?.userCode);
  const dismissedRef = useRef<HTMLParagraphElement>(null);
  // Only a successful answer from this visit counts. A remount can be handed
  // an earlier visit's answer, even while that visit's refetch is still out,
  // and a failed refetch keeps the last answer in status.data.
  // isFetchedAfterMount counts updates since this visit began, so no clock
  // change can make an old answer look new.
  const answer = status.isSuccess && status.isFetchedAfterMount ? status.data : undefined;
  const unapproved = answer !== undefined && answer.valid && !answer.approved;
  const deadline = unapproved ? answer.expiresAt : null;
  const open = deadline !== null && deadline > Date.now();
  const closed = answer !== undefined && !unapproved;

  // Nothing else renders this at the deadline, so the card's claim that the
  // code hasn't expired would outlive it.
  const [, renderAgain] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const wait = deadline === null ? 0 : deadline - Date.now();
    if (wait <= 0) return;
    // A timer delay past 2^31-1 ms fires at once.
    const timer = window.setTimeout(renderAgain, Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [deadline]);

  // The server's answer about this code, written back to session storage.
  useEffect(() => {
    if (held && closed) releaseHeldDeviceLink(held.userCode);
  }, [held, closed]);

  // The card can go while one of its controls has focus: Dismiss, or on its
  // own (the deadline, a failed check, an approval finishing elsewhere).
  // Focus then goes to the line that replaced it, or to the page's heading,
  // the target a navigation uses (route-focus.ts).
  const focusFallback = useFocusFallback(() => dismissedRef.current ?? pageHeading());
  // Dismiss by pointer may not have focused the button (Safari), so the line
  // takes focus here too.
  useEffect(() => {
    if (dismissed) dismissedRef.current?.focus();
  }, [dismissed]);

  if (dismissed) {
    return (
      <div className="mt-8 max-w-[42rem]">
        <p
          ref={dismissedRef}
          tabIndex={-1}
          role="status"
          className="-mx-2 rounded-control px-2 py-1 text-[14px] leading-[1.6] text-ink-secondary"
        >
          Setup won't offer that code again. To link a machine later, run{" "}
          <code className="font-mono text-[13px] text-ink [overflow-wrap:anywhere]">
            {deviceLinkCommand(window.location.origin)}
          </code>{" "}
          in its terminal.
        </p>
      </div>
    );
  }
  if (!held) return null;
  return (
    <>
      {/* Mounted before the answer and empty until it, so a screen reader
          hears the offer arrive however late; the card's controls stay
          outside it. */}
      <p role="status" className="sr-only">
        {open ? `Your earlier device link is available: code ${held.userCode}.` : ""}
      </p>
      {open && (
        <div className="mt-8 max-w-[42rem]" {...focusFallback}>
          <HeldDeviceLinkCard
            held={held}
            onDismiss={() => {
              releaseHeldDeviceLink(held.userCode);
              setHeld(null);
              setDismissed(true);
            }}
          />
        </div>
      )}
    </>
  );
}

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>("main h1");
  if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  return heading;
}

/**
 * Forgets a device link another account held in this tab as soon as the
 * signed-in account changes, on any page, guarded or not. Rendered once in
 * App. Never navigates.
 */
export function HeldDeviceLinkAccountCheck() {
  const { data: session } = useSession();
  const login = session?.user?.login;
  useEffect(() => {
    if (login) forgetHeldDeviceLinkUnlessFor(login);
  }, [login]);
  return null;
}

/** The offer itself. Separate so the gallery can show it without storage or a server. */
export function HeldDeviceLinkCard({ held, onDismiss }: { held: HeldDeviceLink; onDismiss: () => void }) {
  return (
    <section
      aria-label="Your earlier device link"
      className="anim-rise rounded-r-surface border-l-2 border-ink bg-paper-raised px-5 py-4"
    >
      <p className="font-serif text-[18px] leading-snug font-semibold text-ink">
        Your earlier device link is available
      </p>
      <p className="mt-1 text-[14px] leading-[1.6] text-ink-secondary">
        Code <span className="font-mono text-[13.5px] whitespace-nowrap text-ink">{held.userCode}</span> hasn't
        expired or been approved. Approve it only if the terminal where you ran{" "}
        <code className="font-mono text-[13px] text-ink">cogworks link</code> still shows this code.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to={held.path} className={buttonClass("primary")}>
          Review and approve
        </Link>
        <button type="button" onClick={onDismiss} className={buttonClass("quiet")}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
