import { useEffect, useRef, useState } from "react";

/**
 * Taking a person off a list, as a text control that arms before it acts.
 *
 * ConfirmButton does the same two steps for the page's big decisions; this is
 * its size for a row in a roster, where a filled 44px button per person would
 * outweigh the names it sits beside. The first press changes the words to the
 * consequence ("Confirm, they leave the team") and the second carries it out.
 * Arming lapses after four seconds, so a click someone walked away from cannot
 * fire later.
 *
 * The control stays the same element through every state, so keyboard focus
 * never jumps while it arms or works. What happens to focus after the person's
 * row disappears is the caller's job (`onDone`). Escape disarms, as it does on
 * ConfirmButton.
 *
 * The accessible name is the visible words followed by who they apply to, so
 * a voice-control user can say what they see ("Unassign") and a screen reader
 * still hears whose row it is.
 */
export function RemoveButton({
  label = "Remove",
  armedLabel,
  busyLabel = "Removing…",
  subject,
  armedSubject,
  onConfirm,
  busy = false,
  disabled = false,
}: {
  label?: string;
  /** The consequence, said in the label itself. */
  armedLabel: string;
  busyLabel?: string;
  /** Read after the idle label: "@ada from the team" makes "Remove @ada from the team". */
  subject: string;
  /** Read after the armed label, in parentheses: "@ada". */
  armedSubject: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
  };

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <button
      type="button"
      onClick={click}
      onKeyDown={(event) => {
        if (event.key === "Escape" && armed) {
          event.stopPropagation();
          disarm();
        }
      }}
      disabled={disabled || busy}
      aria-live="polite"
      className={`u-pressable inline-flex min-h-11 shrink-0 items-center rounded-control px-2 text-[13.5px] font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${
        armed
          ? "bg-detect-wash text-detect-deep"
          : "text-ink-secondary hover:bg-ink/[0.045] hover:text-ink"
      }`}
    >
      {busy ? busyLabel : armed ? armedLabel : label}
      <span className="sr-only">{armed ? ` (${armedSubject})` : ` ${subject}`}</span>
    </button>
  );
}
