import type { Metric } from "@cogworks/contracts/schema";

export function formatMetricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

export function formatDurationMs(ms: number): string {
  // NaN and infinities fall through every numeric branch and would render
  // as "NaN ms"; a non-finite duration is a programming error, so fail loud.
  if (!Number.isFinite(ms)) {
    throw new Error(
      `formatDurationMs expected a finite duration in milliseconds, received ${ms}`,
    );
  }
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs.toString().padStart(2, "0")}s`;
}

export function formatTimeAgo(epochMs: number): string {
  // NaN survives every comparison below and would render as "NaN d ago";
  // Date.now() is always finite, so checking the input is enough.
  if (!Number.isFinite(epochMs)) {
    throw new Error(
      `formatTimeAgo expected a finite epoch time in milliseconds, received ${epochMs}`,
    );
  }
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

export function formatDateTime(epochMs: number): string {
  // Same contract as formatTimeAgo: non-finite input is a programming error,
  // not a date worth rendering as "Invalid Date".
  if (!Number.isFinite(epochMs)) {
    throw new Error(
      `formatDateTime expected a finite epoch time in milliseconds, received ${epochMs}`,
    );
  }
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function runNumberLabel(id: string): string {
  // Stable, human-scannable run tag from the id tail, e.g. "RUN 3F82".
  return `RUN ${id.slice(-4).toUpperCase()}`;
}

export function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function firstName(name: string | null, login: string): string {
  return name?.split(" ")[0] || login;
}
