import { useState } from "react";

/**
 * A person's face, or the first letter of their login when there is none.
 *
 * Round, to match the account avatar in the header: a square here and a
 * circle there read as two kinds of thing. The fallback is a letter in a ruled
 * circle rather than a generated shape or color, because a color assigned to a
 * person is a label the portal did not earn and cannot explain. A GitHub image
 * that fails to load falls back the same way instead of leaving a broken icon.
 *
 * Always decorative: every caller prints the name beside it, so the image
 * carries no text of its own.
 */
export function MemberAvatar({
  login,
  avatarUrl,
  size = 28,
  className = "",
}: {
  login: string;
  avatarUrl: string | null;
  /** Diameter in px. 20 for inline mentions, 28 for list rows, 36 for a roster. */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        style={box}
        className={`shrink-0 rounded-full bg-paper-sunken object-cover ring-1 ring-rule ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{ ...box, fontSize: Math.round(size * 0.42) }}
      className={`flex shrink-0 items-center justify-center rounded-full border border-rule-strong bg-paper-sunken leading-none font-semibold text-ink-secondary uppercase ${className}`}
    >
      {login.trim()[0] ?? "?"}
    </span>
  );
}
