/** Shared Motion timing — mirrors the CSS design system (--ease-out-quart).
 *  Emil's rules: ease-out entrances, <300ms, origin-aware scale, no springs
 *  for core UI, everything gone under reduced motion. */
export const EASE_OUT = [0.165, 0.84, 0.44, 1] as const;
