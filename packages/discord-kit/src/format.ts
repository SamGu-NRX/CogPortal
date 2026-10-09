import type { Metric } from "@cogworks/contracts/schema";

/**
 * Shared text formatting for Discord surfaces. The house rule after the
 * declutter pass: separation comes from mono code chips and measured space,
 * never from "·" chains. En-spaces survive client whitespace collapsing better
 * than runs of regular spaces (regular runs can collapse on mobile).
 */
export const META_SEP = "\u2002\u2002";

export function metricValue(metric: Metric): string {
  // A non-finite value means a metric skipped schema validation somewhere;
  // rendering it would print "NaN" into a live Discord surface.
  if (!Number.isFinite(metric.value)) {
    throw new TypeError(`metricValue: metric "${metric.key}" must have a finite value, got ${metric.value}`);
  }
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

/** An inline mono chip; Discord's code-span background does the separating. */
export function chip(value: string): string {
  // A backtick closes the code span early and a newline breaks it entirely,
  // so either one renders broken markup instead of a chip.
  if (value.includes("`") || value.includes("\n")) {
    const echoed = value.length > 40 ? `${value.slice(0, 40)}...` : value;
    throw new TypeError(`chip: value must be a single line without backticks, got "${echoed}"`);
  }
  return `\`${value}\``;
}

export function elapsed(value: number): string {
  // Math.max(0, NaN) is NaN, so a NaN input would otherwise print "NaN:NaN".
  if (!Number.isFinite(value)) {
    throw new TypeError(`elapsed: expected a finite number of milliseconds, got ${value}`);
  }
  const seconds = Math.max(0, Math.floor(value / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes
    ? `${minutes}:${String(seconds % 60).padStart(2, "0")}`
    : `0:${String(seconds).padStart(2, "0")}`;
}

/** Joins the present parts of a metadata line with the house separator. */
export function metaLine(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts.filter((part): part is string => Boolean(part)).join(META_SEP);
}

/**
 * The 4,000-character message limit is aggregate across every text display.
 * Returns the lines that fit, dropping from the end of the flexible region
 * (event tails and step lists shrink before identity or actions ever would).
 */
export function fitTextBudget(
  fixed: ReadonlyArray<string>,
  flexible: ReadonlyArray<string>,
  limit = 4_000,
): string[] {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new TypeError(`fitTextBudget: limit must be a finite number >= 0, got ${limit}`);
  }
  const fixedLength = fixed.reduce((total, line) => total + line.length + 1, 0);
  let remaining = limit - fixedLength;
  const kept: string[] = [];
  for (const line of flexible) {
    // Callers join the kept lines with "\n", so a line only pays for a
    // newline when another kept line is already in front of it. A lone line
    // joins with no separator at all, and the last line never pays for a
    // trailing one.
    const separator = kept.length > 0 ? 1 : 0;
    if (line.length + separator > remaining) break;
    kept.push(line);
    remaining -= line.length + separator;
  }
  return kept;
}
