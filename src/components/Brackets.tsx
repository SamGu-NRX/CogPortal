/**
 * Detection-box corner brackets — the portal's single geometric motif
 * (plan §8: "detection-box geometry as a restrained motif"). Wrap any
 * relatively-positioned box to mark it as "the instrument is looking here":
 * the current phase, the primary metric, an empty slot awaiting data.
 */
export function CornerBrackets({
  size = 10,
  thickness = 1.5,
  inset = 0,
  className = "text-detect",
}: {
  size?: number;
  thickness?: number;
  /** Negative values push brackets outside the box. */
  inset?: number;
  className?: string;
}) {
  const corners = [
    { top: inset, left: inset, borderTopWidth: thickness, borderLeftWidth: thickness },
    { top: inset, right: inset, borderTopWidth: thickness, borderRightWidth: thickness },
    { bottom: inset, right: inset, borderBottomWidth: thickness, borderRightWidth: thickness },
    { bottom: inset, left: inset, borderBottomWidth: thickness, borderLeftWidth: thickness },
  ] as const;

  return (
    <span aria-hidden="true" className={`pointer-events-none ${className}`}>
      {corners.map((style, i) => (
        <span
          key={i}
          className="absolute block border-current"
          style={{ width: size, height: size, borderWidth: 0, ...style }}
        />
      ))}
    </span>
  );
}
