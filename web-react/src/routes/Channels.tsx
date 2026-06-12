import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  useAllowChannelEventIdentity,
  useToolServiceAction,
  useToolServiceEvents,
  useToolServiceLogs,
  useToolServices,
  useUpdateToolServiceRestartPolicy,
} from "@/api/toolServices";
import {
  useCreateChannelIdentity,
  useDeleteChannelIdentity,
  useUpdateChannelIdentity,
  useUsers,
} from "@/api/users";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type {
  ToolServiceEventDirection,
  ToolServiceEventRecord,
  ToolServiceStatus,
  UserRecord,
} from "@/api/types";
import {
  eventTone,
  filterChannelEvents,
  filterChannelIdentities,
  flattenChannelIdentities,
  summarizeChannelHealth,
  type ChannelIdentityView,
} from "@/features/channels/channelPresentation";

const allServices = "all";
const defaultProvider = "channel.telegram.bot";

export function ChannelsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const serviceFilter = searchParams.get("service") ?? allServices;
  const directionFilter = (searchParams.get("direction") as ToolServiceEventDirection | "all" | null) ?? "all";
  const [search, setSearch] = useState("");

  const services = useToolServices();
  const users = useUsers();
  const events = useToolServiceEvents({
    toolName: serviceFilter === allServices ? undefined : serviceFilter,
    direction: directionFilter,
    limit: 160,
  });
  const logs = useToolServiceLogs({
    toolName: serviceFilter === allServices ? undefined : serviceFilter,
    limit: 120,
  });

  const serviceOptions = services.data ?? [];
  const allEvents = events.data ?? [];
  const allUsers = users.data ?? [];
  const identities = useMemo(() => flattenChannelIdentities(allUsers), [allUsers]);
  const serviceNames = useMemo(
    () =>
      [
        ...new Set([
          ...serviceOptions.map((service) => service.toolName),
          ...allEvents.map((event) => event.toolName),
          ...identities.map((identity) => identity.provider),
        ]),
      ].sort(),
    [serviceOptions, allEvents, identities],
  );
  const health = useMemo(
    () => summarizeChannelHealth({ services: serviceOptions, events: allEvents, users: allUsers }),
    [serviceOptions, allEvents, allUsers],
  );
  const visibleEvents = useMemo(
    () => filterChannelEvents(allEvents, { service: serviceFilter, direction: directionFilter, search }),
    [allEvents, serviceFilter, directionFilter, search],
  );
  const visibleIdentities = useMemo(
    () => filterChannelIdentities(identities, { service: serviceFilter, search }),
    [identities, serviceFilter, search],
  );

  const setFilter = (key: "service" | "direction", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === allServices || value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">
              Always-on runtime
            </p>
            <h2 className="text-xl font-semibold">Channels</h2>
            <p className="mt-1 max-w-3xl text-sm text-app-text-muted">
              Provider-neutral service console for bots, webhooks, listeners, inbound events,
              identity allowlists, outbound delivery, restart policy, and lifecycle logs.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              to="/users"
              className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 font-semibold hover:border-app-accent/50 hover:text-app-accent"
            >
              Manage users
            </Link>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Services" value={`${health.runningServices}/${health.serviceCount}`} detail="running" />
          <Metric label="Inbound review" value={health.pendingInbound} detail="received / ignored" tone={health.pendingInbound ? "warn" : "muted"} />
          <Metric label="Outbound queue" value={health.outboundNeedsAttention} detail="queued / failed" tone={health.outboundNeedsAttention ? "warn" : "muted"} />
          <Metric label="Allowed IDs" value={health.allowedIdentities} detail="whitelisted" tone="ok" />
          <Metric label="Blocked IDs" value={health.blockedIdentities} detail="blocked" tone={health.blockedIdentities ? "danger" : "muted"} />
        </div>
      </header>

      <FilterBar
        services={serviceOptions}
        serviceNames={serviceNames}
        serviceFilter={serviceFilter}
        directionFilter={directionFilter}
        search={search}
        onServiceChange={(value) => setFilter("service", value)}
        onDirectionChange={(value) => setFilter("direction", value)}
        onSearchChange={setSearch}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <SectionHeader
            title="Installed services"
            detail="Start, stop, heartbeat, and restart policy for generated always-on tools."
          />
          {services.isLoading ? (
            <EmptyLine>Loading services…</EmptyLine>
          ) : serviceOptions.length === 0 ? (
            <EmptyLine>No always-on services installed.</EmptyLine>
          ) : (
            <div className="mt-3 grid gap-3 2xl:grid-cols-2">
              {serviceOptions
                .filter((service) => serviceFilter === allServices || service.toolName === serviceFilter)
                .map((service) => (
                  <ServiceCard key={service.toolName} service={service} />
                ))}
            </div>
          )}
        </article>

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <SectionHeader
            title="Channel identities"
            detail="Map provider user ids or handles to local users. Unknown inbound events can be allowed from the event list."
          />
          <IdentityCreateForm
            users={allUsers}
            serviceNames={serviceNames}
            defaultProvider={serviceFilter === allServices ? defaultProvider : serviceFilter}
          />
          <ul className="mt-3 flex max-h-[460px] flex-col gap-2 overflow-y-auto pr-1">
            {visibleIdentities.map((identity) => (
              <IdentityRow key={identity.id} identity={identity} />
            ))}
            {visibleIdentities.length === 0 ? <EmptyLine list>No identities match this view.</EmptyLine> : null}
          </ul>
        </article>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <SectionHeader
            title="Event stream"
            detail="Inbound, outbound, and system handoffs. Linked runs and conversations stay visible for audit."
          />
          <ul className="mt-3 flex max-h-[620px] flex-col gap-2 overflow-y-auto pr-1">
            {visibleEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
            {visibleEvents.length === 0 ? <EmptyLine list>No channel events match this view.</EmptyLine> : null}
          </ul>
        </article>

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <SectionHeader
            title="Lifecycle log"
            detail="Supervisor actions, heartbeats, restart attempts, and runtime failures."
          />
          <ul className="mt-3 max-h-[620px] overflow-y-auto pr-1 font-mono text-[11px]">
            {(logs.data ?? []).map((log) => (
              <li key={log.id} className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-2 border-b border-app-border/50 py-1.5 last:border-b-0">
                <span className="text-app-text-muted">{new Date(log.createdAt).toLocaleTimeString()}</span>
                <span className={log.level === "error" ? "text-app-danger" : log.level === "warn" ? "text-app-warning" : "text-app-text-muted"}>
                  {log.level}
                </span>
                <span className="min-w-0 break-words">
                  <span className="text-app-text-muted">{log.toolName}</span>
                  {" · "}
                  {log.message}
                  {log.detail ? <span className="text-app-text-muted"> · {truncate(log.detail, 180)}</span> : null}
                </span>
              </li>
            ))}
            {(logs.data ?? []).length === 0 ? <EmptyLine list>No lifecycle logs yet.</EmptyLine> : null}
          </ul>
        </article>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "muted",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "ok" | "warn" | "danger" | "muted";
}) {
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
      <p className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</p>
      <p className={["mt-1 text-2xl font-semibold", tone === "ok" ? "text-app-accent" : tone === "warn" ? "text-app-warning" : tone === "danger" ? "text-app-danger" : ""].join(" ")}>
        {value}
      </p>
      <p className="text-[11px] text-app-text-muted">{detail}</p>
    </div>
  );
}

function FilterBar({
  services,
  serviceNames,
  serviceFilter,
  directionFilter,
  search,
  onServiceChange,
  onDirectionChange,
  onSearchChange,
}: {
  services: ToolServiceStatus[];
  serviceNames: string[];
  serviceFilter: string;
  directionFilter: ToolServiceEventDirection | "all";
  search: string;
  onServiceChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}) {
  return (
    <article className="grid gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 md:grid-cols-[minmax(0,1fr)_180px_180px]">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Search</span>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search events, users, source ids, run ids…"
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Service</span>
        <select
          value={serviceFilter}
          onChange={(event) => onServiceChange(event.target.value)}
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60"
        >
          <option value={allServices}>All services</option>
          {serviceNames.map((name) => {
            const service = services.find((candidate) => candidate.toolName === name);
            return (
              <option key={name} value={name}>
                {service?.displayName ?? name}
              </option>
            );
          })}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Direction</span>
        <select
          value={directionFilter}
          onChange={(event) => onDirectionChange(event.target.value)}
          className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 outline-none focus:border-app-accent/60"
        >
          <option value="all">All directions</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
          <option value="system">System</option>
        </select>
      </label>
    </article>
  );
}

function SectionHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-app-text-muted">{detail}</p>
    </header>
  );
}

function ServiceCard({ service }: { service: ToolServiceStatus }) {
  const action = useToolServiceAction();
  const policy = useUpdateToolServiceRestartPolicy();
  const isRunningDesired = service.desiredState === "running";
  const actionDisabled = action.isPending || policy.isPending;

  return (
    <article className="min-w-0 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="block break-words text-sm">{service.displayName ?? service.toolName}</strong>
          <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">{service.toolName}</p>
        </div>
        <GenericBadge tone={statusTone(service.status)}>{service.status}</GenericBadge>
      </header>
      <p className="mt-2 break-words text-[11px] text-app-text-muted">{truncate(service.detail ?? service.description, 260)}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <KeyValue label="desired" value={service.desiredState} />
        <KeyValue label="heartbeat" value={service.lastHeartbeatAt ? formatRelative(service.lastHeartbeatAt) : "never"} />
        <KeyValue label="restart count" value={String(service.restartCount)} />
        <KeyValue label="failures" value={String(service.consecutiveFailureCount)} />
      </dl>
      {service.pendingRestartApproval ? (
        <p className="mt-2 rounded bg-app-warning-soft px-2 py-1 text-[11px] text-app-warning">
          Pending restart approval. Use Approvals or restart explicitly.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => action.mutate({ name: service.toolName, action: isRunningDesired ? "stop" : "start" })}
          disabled={actionDisabled}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          {isRunningDesired ? "Stop" : "Start"}
        </button>
        <button
          type="button"
          onClick={() => action.mutate({ name: service.toolName, action: "restart" })}
          disabled={actionDisabled}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => action.mutate({ name: service.toolName, action: "heartbeat" })}
          disabled={actionDisabled}
          className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          Heartbeat
        </button>
      </div>
      <div className="mt-3 grid gap-2 border-t border-app-border pt-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={Boolean(service.autoRestartEnabled)}
            onChange={(event) =>
              policy.mutate({
                name: service.toolName,
                policy: { autoRestartEnabled: event.target.checked },
              })
            }
          />
          auto restart
        </label>
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={Boolean(service.restartRequiresApproval)}
            onChange={(event) =>
              policy.mutate({
                name: service.toolName,
                policy: { restartRequiresApproval: event.target.checked },
              })
            }
          />
          approval gate
        </label>
      </div>
      {action.isError ? <p className="mt-2 text-[11px] text-app-danger">{action.error.message}</p> : null}
      {policy.isError ? <p className="mt-2 text-[11px] text-app-danger">{policy.error.message}</p> : null}
    </article>
  );
}

function IdentityCreateForm({
  users,
  serviceNames,
  defaultProvider,
}: {
  users: UserRecord[];
  serviceNames: string[];
  defaultProvider: string;
}) {
  const create = useCreateChannelIdentity();
  const [userId, setUserId] = useState("user-admin");
  const [provider, setProvider] = useState(defaultProvider);
  const [providerUserId, setProviderUserId] = useState("");
  const [allowStatus, setAllowStatus] = useState<"allowed" | "blocked">("allowed");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanProvider = provider.trim();
    const cleanProviderUserId = providerUserId.trim();
    if (!cleanProvider || !cleanProviderUserId || !userId) return;
    create.mutate(
      {
        userId,
        input: {
          provider: cleanProvider,
          providerUserId: cleanProviderUserId,
          userId,
          allowStatus,
          displayMetadata: { source: "channels-ui" },
          lastSeenAt: new Date().toISOString(),
        },
      },
      { onSuccess: () => setProviderUserId("") },
    );
  };

  return (
    <form onSubmit={submit} className="mt-3 grid gap-2 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">User</span>
          <select
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Provider</span>
          <input
            list="channel-service-providers"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="generated.telegram.family-bot"
            className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
          />
          <datalist id="channel-service-providers">
            <option value={defaultProvider} />
            {serviceNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_130px_auto]">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Provider user id / handle</span>
          <input
            value={providerUserId}
            onChange={(event) => setProviderUserId(event.target.value)}
            placeholder="@username or numeric id"
            className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Status</span>
          <select
            value={allowStatus}
            onChange={(event) => setAllowStatus(event.target.value as "allowed" | "blocked")}
            className="rounded-md border border-app-border bg-app-surface px-2 py-1.5 outline-none focus:border-app-accent/60"
          >
            <option value="allowed">allowed</option>
            <option value="blocked">blocked</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={create.isPending || !provider.trim() || !providerUserId.trim()}
          className="self-end rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
        >
          Add identity
        </button>
      </div>
      {create.isError ? <p className="text-[11px] text-app-danger">{create.error.message}</p> : null}
    </form>
  );
}

function IdentityRow({ identity }: { identity: ChannelIdentityView }) {
  const update = useUpdateChannelIdentity();
  const remove = useDeleteChannelIdentity();
  const nextStatus = identity.allowStatus === "allowed" ? "blocked" : "allowed";

  return (
    <li className="rounded-md border border-app-border bg-app-surface-2 p-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-mono text-[11px]">{identity.providerUserId}</p>
          <p className="break-all font-mono text-[10px] text-app-text-muted">{identity.provider}</p>
          <p className="mt-1 text-[11px] text-app-text-muted">
            {identity.userDisplayName} · {identity.userRole}
            {identity.lastSeenAt ? ` · seen ${formatRelative(identity.lastSeenAt)}` : ""}
          </p>
        </div>
        <GenericBadge tone={identity.allowStatus === "allowed" ? "ok" : "danger"}>
          {identity.allowStatus}
        </GenericBadge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => update.mutate({ id: identity.id, update: { allowStatus: nextStatus } })}
          disabled={update.isPending || remove.isPending}
          className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px] disabled:opacity-50"
        >
          Mark {nextStatus}
        </button>
        <button
          type="button"
          onClick={() => remove.mutate(identity.id)}
          disabled={update.isPending || remove.isPending}
          className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px] text-app-danger disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function EventRow({ event }: { event: ToolServiceEventRecord }) {
  const allow = useAllowChannelEventIdentity();
  const ignored = event.status === "ignored" && Boolean(event.sourceUserId);
  return (
    <li className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-app-text-muted">{new Date(event.createdAt).toLocaleString()}</span>
            <GenericBadge tone={event.direction === "outbound" ? "ok" : event.direction === "inbound" ? "warn" : "muted"}>
              {event.direction}
            </GenericBadge>
            <GenericBadge tone={eventTone(event)}>{event.status}</GenericBadge>
          </div>
          <p className="mt-2 break-words font-medium">{event.summary}</p>
          <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
            {event.toolName}
            {event.sourceUserId ? ` · user ${event.sourceUserId}` : ""}
            {event.sourceChatId ? ` · chat ${event.sourceChatId}` : ""}
            {event.sourceMessageId ? ` · message ${event.sourceMessageId}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {event.runId ? (
            <Link to={`/run/${event.runId}`} className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] hover:border-app-accent/50">
              Open run
            </Link>
          ) : null}
          {event.threadId ? (
            <Link to={`/conversation/${event.threadId}`} className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] hover:border-app-accent/50">
              Open thread
            </Link>
          ) : null}
          {ignored ? (
            <button
              type="button"
              onClick={() => allow.mutate(event.id)}
              disabled={allow.isPending}
              className="rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-[10px] font-semibold text-app-warning disabled:opacity-50"
            >
              Allow as admin
            </button>
          ) : null}
        </div>
      </div>
      {event.payload ? (
        <details className="mt-2 rounded border border-app-border bg-app-surface px-2 py-1">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-app-text-muted">
            Payload
          </summary>
          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[10px] text-app-text-muted">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
      ) : null}
      {allow.isError ? <p className="mt-1 text-[11px] text-app-danger">{allow.error.message}</p> : null}
    </li>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-app-border bg-app-surface px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function EmptyLine({ children, list = false }: { children: ReactNode; list?: boolean }) {
  const className = "rounded-md border border-dashed border-app-border p-3 text-xs text-app-text-muted";
  return list ? <li className={className}>{children}</li> : <p className={className}>{children}</p>;
}

function statusTone(status: ToolServiceStatus["status"]): "ok" | "warn" | "danger" | "muted" {
  if (status === "running") return "ok";
  if (status === "starting") return "warn";
  if (status === "failed") return "danger";
  return "muted";
}
