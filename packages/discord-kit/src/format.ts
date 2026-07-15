import type { Metric } from "@cogworks/contracts/schema";

/**
 * Shared text formatting for Discord surfaces. The house rule after the
 * declutter pass: separation comes from mono code chips and measured space,
 * never from "·" chains. En-spaces survive client whitespace collapsing better
 * than runs of regular spaces (regular runs can collapse on mobile).
 */
export const META_SEP = "\u2002\u2002";

export function metricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

/** An inline mono chip; Discord's code-span background does the separating. */
export function chip(value: string): string {
  return `\`${value}\``;
}

export function elapsed(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes
    ? `${minutes}:${String(seconds % 60).padStart(2, "0")}`
    : `0:${String(seconds).padStart(2, "0")}`;
}

/** Joins the present parts of a metadata line with the house separator. */
export function metaLine(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => Boolean(part)).join(META_SEP);
}

/**
 * The 4,000-character message limit is aggregate across every text display.
 * Returns the lines that fit, dropping from the end of the flexible region
 * (event tails and step lists shrink before identity or actions ever would).
 */
export function fitTextBudget(
  fixed: string[],
  flexible: string[],
  limit = 4_000,
): string[] {
  const fixedLength = fixed.reduce((total, line) => total + line.length + 1, 0);
  let remaining = limit - fixedLength;
  const kept: string[] = [];
  for (const line of flexible) {
    if (line.length + 1 > remaining) break;
    kept.push(line);
    remaining -= line.length + 1;
  }
  return kept;
}
