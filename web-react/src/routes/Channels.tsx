import { useEffect, useRef, useState } from "react";

import {
  useAllowChannelEventIdentity,
  useToolServiceAction,
  useToolServiceEvents,
  useToolServiceLogs,
  useToolServices,
} from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolServiceEventRecord, ToolServiceStatus } from "@/api/types";

export function ChannelsPage() {
  const services = useToolServices();
  const events = useToolServiceEvents();
  const logs = useToolServiceLogs();

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h2 className="text-base font-semibold">Channels</h2>
        <p className="mt-1 text-xs text-app-text-muted">
          Always-on tools (Telegram bots, listeners, webhooks) and their inbound/outbound
          message log. Use Tool Builds to register new always-on integrations.
        </p>
      </header>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Installed services</h3>
        {services.isLoading ? (
          <p className="mt-2 text-xs text-app-text-muted">Loading…</p>
        ) : (services.data ?? []).length === 0 ? (
          <p className="mt-2 text-xs text-app-text-muted">No always-on services installed.</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {services.data!.map((service) => (
              <ServiceCard key={service.toolName} service={service} />
            ))}
          </div>
        )}
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Recent events</h3>
        <p className="mt-1 text-xs text-app-text-muted">
          Provider-neutral inbound/outbound events. Use <em>Allow as admin</em> to whitelist
          an unknown channel identity that hit the runtime.
        </p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {(events.data ?? []).slice(0, 25).map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
          {(events.data ?? []).length === 0 ? (
            <li className="text-xs text-app-text-muted">No events yet.</li>
          ) : null}
        </ul>
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Lifecycle log</h3>
        <ul className="mt-2 max-h-72 overflow-y-auto font-mono text-[11px]">
          {(logs.data ?? []).slice(0, 80).map((log) => (
            <li key={log.id} className="grid grid-cols-[auto_auto_auto_1fr] gap-2 py-0.5">
              <span className="text-app-text-muted">{new Date(log.createdAt).toLocaleTimeString()}</span>
              <span
                className={
                  log.level === "error"
                    ? "text-app-danger"
                    : log.level === "warn"
                      ? "text-app-warning"
                      : "text-app-text-muted"
                }
              >
                {log.level}
              </span>
              <span className="text-app-text-muted">{log.toolName}</span>
              <span>{truncate(log.message, 200)}</span>
            </li>
          ))}
          {(logs.data ?? []).length === 0 ? (
            <li className="text-xs text-app-text-muted">No logs yet.</li>
          ) : null}
        </ul>
      </article>
    </section>
  );
}

function ServiceCard({ service }: { service: ToolServiceStatus }) {
  const action = useToolServiceAction();
  const previousStatus = useRef(service.status);

  // Just so we re-render heartbeat age client-side.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    previousStatus.current = service.status;
  }, [service.status]);

  return (
    <article className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <header className="flex items-baseline justify-between gap-2">
        <strong className="text-sm">{service.displayName ?? service.toolName}</strong>
        <GenericBadge tone={statusTone(service.status)}>{service.status}</GenericBadge>
      </header>
      <p className="mt-1 font-mono text-[10px] text-app-text-muted">
        {service.toolName} · desired {service.desiredState}
      </p>
      <p className="mt-1 text-[11px] text-app-text-muted">{truncate(service.detail ?? "", 220)}</p>
      <p className="mt-1 text-[11px]">
        last heartbeat:{" "}
        {service.lastHeartbeatAt ? formatRelative(service.lastHeartbeatAt) : "never"}
        {typeof service.lastHealthOk === "boolean" ? (
          <>
            {" · "}
            <GenericBadge tone={service.lastHealthOk ? "ok" : "danger"}>
              {service.lastHealthOk ? "healthy" : "unhealthy"}
            </GenericBadge>
          </>
        ) : null}
      </p>
      {service.pendingRestartApproval ? (
        <p className="mt-1 rounded bg-app-warning-soft px-2 py-1 text-[11px] text-app-warning">
          Pending restart approval — open Approvals to handle.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {service.desiredState === "stopped" ? (
          <button
            type="button"
            onClick={() => action.mutate({ name: service.toolName, action: "start" })}
            disabled={action.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
          >
            Start
          </button>
        ) : (
          <button
            type="button"
            onClick={() => action.mutate({ name: service.toolName, action: "stop" })}
            disabled={action.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => action.mutate({ name: service.toolName, action: "restart" })}
          disabled={action.isPending}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => action.mutate({ name: service.toolName, action: "heartbeat" })}
          disabled={action.isPending}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          Heartbeat
        </button>
      </div>
      {action.isError ? (
        <p className="mt-1 text-[11px] text-app-danger">{action.error.message}</p>
      ) : null}
    </article>
  );
}

function EventRow({ event }: { event: ToolServiceEventRecord }) {
  const allow = useAllowChannelEventIdentity();
  const ignored = event.status === "ignored";
  return (
    <li className="grid grid-cols-[auto_auto_auto_1fr_auto] items-baseline gap-2 rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-[11px]">
      <span className="text-[10px] text-app-text-muted">
        {new Date(event.createdAt).toLocaleTimeString()}
      </span>
      <GenericBadge tone={directionTone(event.direction, event.status)}>
        {event.direction}
      </GenericBadge>
      <GenericBadge tone={eventStatusTone(event.status)}>{event.status}</GenericBadge>
      <div className="min-w-0">
        <p className="truncate">{event.summary}</p>
        <p className="truncate font-mono text-[10px] text-app-text-muted">
          {event.toolName}
          {event.sourceUserId ? ` · ${event.sourceUserId}` : ""}
          {event.runId ? ` · run ${event.runId}` : ""}
        </p>
      </div>
      {ignored ? (
        <button
          type="button"
          onClick={() => allow.mutate(event.id)}
          disabled={allow.isPending}
          className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px] text-app-warning disabled:opacity-50"
          title="Whitelist this provider identity as the local admin user."
        >
          Allow as admin
        </button>
      ) : null}
    </li>
  );
}

function statusTone(status: ToolServiceStatus["status"]): "ok" | "warn" | "danger" | "muted" {
  if (status === "running") return "ok";
  if (status === "starting") return "warn";
  if (status === "failed") return "danger";
  return "muted";
}

function directionTone(
  direction: ToolServiceEventRecord["direction"],
  status: ToolServiceEventRecord["status"],
): "ok" | "warn" | "danger" | "muted" {
  if (status === "failed") return "danger";
  if (direction === "inbound") return "muted";
  if (direction === "outbound") return "ok";
  return "warn";
}

function eventStatusTone(status: ToolServiceEventRecord["status"]): "ok" | "warn" | "danger" | "muted" {
  switch (status) {
    case "received":
    case "queued":
      return "warn";
    case "sent":
      return "ok";
    case "failed":
      return "danger";
    case "ignored":
      return "muted";
    default:
      return "muted";
  }
}
