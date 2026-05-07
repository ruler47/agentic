import type { RunStatus } from "@/api/types";

type Tone = "ok" | "running" | "warn" | "danger" | "muted";

const toneClass: Record<Tone, string> = {
  ok: "bg-app-accent-soft text-app-accent",
  running: "bg-[rgba(110,168,255,0.15)] text-app-info",
  warn: "bg-app-warning-soft text-app-warning",
  danger: "bg-app-danger-soft text-app-danger",
  muted: "bg-app-surface-2 text-app-text-muted",
};

function runStatusTone(status: string): Tone {
  switch (status) {
    case "completed":
      return "ok";
    case "running":
    case "queued":
      return "running";
    case "waiting_tool_rework":
      return "warn";
    case "failed":
      return "danger";
    case "cancelled":
      return "muted";
    default:
      return "muted";
  }
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "waiting_tool_rework":
      return "waiting tool";
    default:
      return status.replace(/_/g, " ");
  }
}

export function RunStatusBadge({ status }: { status: RunStatus | string }) {
  const tone = runStatusTone(status);
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        toneClass[tone],
      ].join(" ")}
    >
      {runStatusLabel(status)}
    </span>
  );
}

export function GenericBadge({ children, tone = "muted" }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        toneClass[tone],
      ].join(" ")}
    >
      {children}
    </span>
  );
}
