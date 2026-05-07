export function formatRelative(value: string | number | Date | undefined): string {
  if (!value) return "—";
  const ts = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : value.getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  const abs = Math.abs(diffMs);
  const sign = diffMs >= 0 ? "" : "in ";
  const suffix = diffMs >= 0 ? "ago" : "";
  const seconds = Math.round(abs / 1000);
  if (seconds < 5) return diffMs >= 0 ? "just now" : "soon";
  if (seconds < 60) return `${sign}${seconds}s ${suffix}`.trim();
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${sign}${minutes}m ${suffix}`.trim();
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${sign}${hours}h ${suffix}`.trim();
  const days = Math.round(hours / 24);
  if (days < 14) return `${sign}${days}d ${suffix}`.trim();
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function runDurationMs(run: { createdAt: string; updatedAt: string; status: string }): number {
  const start = new Date(run.createdAt).getTime();
  const isLive = run.status === "queued" || run.status === "running";
  const end = isLive ? Date.now() : new Date(run.updatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function truncate(value: string | undefined | null, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
