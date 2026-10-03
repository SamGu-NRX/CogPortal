import type { Metric } from "@cogworks/contracts/schema";

export function formatMetricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs.toString().padStart(2, "0")}s`;
}

export function formatTimeAgo(epochMs: number): string {
  const delta = Date.now() - epochMs;
  const s = Math.round(delta / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

/** The calendar day alone, e.g. "Oct 2", and the same day as a `<time>`
 *  attribute. Both read the local date, so they always agree. */
export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function isoDate(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function runNumberLabel(id: string): string {
  // Stable, scannable tag from the id tail, e.g. "Run #3F82". The "#" marks it
  // as an identifier: an all-letters tail otherwise reads as a word ("RUN
  // DACE"). A page that can say more (mode, branch) leads with that instead.
  return `Run #${id.slice(-4).toUpperCase()}`;
}


export function firstName(name: string | null, login: string): string {
  return name?.split(" ")[0] || login;
}
