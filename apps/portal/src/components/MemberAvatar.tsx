/**
 * A person, at the size the row around them needs.
 *
 * The fallback is the first letter in a bordered box rather than a generated
 * shape or color, because a color assigned to a person is a label the portal
 * did not earn and cannot explain.
 */
export function MemberAvatar({
  login,
  avatarUrl,
  className = "size-6",
}: {
  login: string;
  avatarUrl: string | null;
  /** Box size. Defaults to the members list's 24px. */
  className?: string;
}) {
  return avatarUrl ? (
    <img src={avatarUrl} alt="" className={`${className} shrink-0 rounded-[2px]`} />
  ) : (
    <span
      aria-hidden="true"
      className={`${className} flex shrink-0 items-center justify-center border border-rule bg-paper-sunken font-mono text-[10px] text-ink-secondary uppercase`}
    >
      {login[0]}
    </span>
  );
}
