/** Shared Motion timing — mirrors the CSS design system (--ease-out-quart).
 *  Emil's rules: ease-out entrances, <300ms, origin-aware scale, no springs
 *  for core UI, everything gone under reduced motion. */
export const EASE_OUT = [0.165, 0.84, 0.44, 1] as const;

/** For elements already on screen that move or morph (Emil: ease-in-out). */
export const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const;

/** Stronger ease-out for a one-time entrance that should feel decisive. */
export const EASE_OUT_STRONG = [0.23, 1, 0.32, 1] as const;
