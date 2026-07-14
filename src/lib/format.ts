import type { Metric } from "@shared/schema";

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

export function formatDateTime(epochMs: number): string {
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
