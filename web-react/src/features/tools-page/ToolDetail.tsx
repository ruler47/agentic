import { useState } from "react";

import {
  useDeleteGeneratedTool,
  useDeleteToolSetting,
  useSetToolStatus,
  useSetToolSetting,
} from "@/api/tools";
import { useToolServiceAction } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolCatalogEntry, ToolServiceStatus } from "@/api/types";
import { useSecretHandleStatuses } from "@/api/secretHandles";

import { ToolEditPanel } from "./ToolEditPanel";
import { ToolContextPanel } from "./ToolContextPanel";
import { ManualRunPanel } from "./ManualRunPanel";
import { ToolSecretHandlePanel } from "./ToolSecretHandlePanel";
import { VersionsPanel } from "./VersionsPanel";
import { Metric, Section, compareVersionsDesc, formatSuccessRate, serviceTone, statusTone } from "./toolsPageShared";

type ToolDetailTabId = "overview" | "run" | "edit" | "versions" | "context" | "settings";

export function ToolDetail({
  tool,
  settings,
  service,
}: {
  tool: ToolCatalogEntry;
  settings: Record<string, string>;
  service?: ToolServiceStatus;
}) {
  const setSetting = useSetToolSetting();
  const deleteSetting = useDeleteToolSetting();
  const deleteGenerated = useDeleteGeneratedTool();
  const serviceAction = useToolServiceAction();
  const setStatus = useSetToolStatus();
  const [selectedTab, setSelectedTab] = useState<ToolDetailTabId>("overview");

  const requiredKeys = tool.requiredConfigurationKeys ?? [];
  const requiredSecretHandles = tool.requiredSecretHandles ?? [];
  const runtimeReadiness = tool.runtimeReadiness;
  const secretStatuses = useSecretHandleStatuses(requiredSecretHandles);
  const settingsSchema = (tool.settingsSchema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: string[] }
  >;
  const allKeys = Array.from(new Set([
    ...Object.keys(settingsSchema),
    ...requiredKeys,
    ...Object.keys(settings),
  ]));
  const generatedTabs: Array<{ id: ToolDetailTabId; label: string }> = tool.source === "generated"
    ? [
      { id: "edit", label: "Edit" },
      { id: "versions", label: "Versions" },
      { id: "context", label: "Context" },
    ]
    : [];
  const tabs: Array<{ id: ToolDetailTabId; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "run", label: "Run" },
    ...generatedTabs,
    { id: "settings", label: "Settings" },
  ];
  const activeTab = tabs.some((tab) => tab.id === selectedTab) ? selectedTab : "overview";
  const newerInactiveVersions = (tool.versions ?? [])
    .filter((version) => !version.active && compareVersionsDesc(version.version, tool.version) < 0)
    .filter((version) => version.status !== "failed" && version.reviewStatus !== "rejected")
    .slice(0, 3);

  return (
    <article className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold">
            {tool.displayName ?? tool.name}
            <span className="ml-2 font-mono text-xs text-app-text-muted">v{tool.version}</span>
          </h2>
          <p className="mt-1 text-xs text-app-text-muted">{tool.description}</p>
          <p className="mt-1 font-mono text-[10px] text-app-text-muted">
            {tool.name} · {tool.source} · startup {tool.startupMode ?? "on-demand"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GenericBadge tone={statusTone(tool.status)}>{tool.status}</GenericBadge>
          <GenericBadge tone={tool.agentEligibility.offered ? "ok" : "warn"}>
            {tool.agentEligibility.offered ? "offered to agents" : "not offered"}
          </GenericBadge>
          {typeof tool.lastHealthOk === "boolean" ? (
            <GenericBadge tone={tool.lastHealthOk ? "ok" : "danger"}>
              {tool.lastHealthOk ? "healthy" : "unhealthy"}
            </GenericBadge>
          ) : null}
          {runtimeReadiness ? (
            <GenericBadge tone={runtimeReadiness.ok ? "ok" : "warn"}>
              {runtimeReadiness.ok ? "runtime ready" : "runtime blocked"}
            </GenericBadge>
          ) : null}
          {service ? (
            <GenericBadge tone={serviceTone(service.status)}>
              service {service.status}
            </GenericBadge>
          ) : null}
        </div>
      </header>

      <ToolDetailTabs tabs={tabs} activeTab={activeTab} onSelect={setSelectedTab} />

      {activeTab === "overview" && service ? (
        <Section title="Service lifecycle">
          <div className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p>
                  Runtime: <span className="font-mono">{service.status}</span> · desired{" "}
                  <span className="font-mono">{service.desiredState}</span>
                </p>
                <p className="mt-1 text-[11px] text-app-text-muted">
                  {service.detail || "No lifecycle detail."}
                </p>
                {service.lastHeartbeatAt ? (
                  <p className="mt-1 text-[11px] text-app-text-muted">
                    heartbeat {formatRelative(service.lastHeartbeatAt)}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(["start", "stop", "restart", "heartbeat"] as const).map((action) => (
                  <button
                    key={action}
                    type="button"
                    disabled={serviceAction.isPending}
                    onClick={() => serviceAction.mutate({ name: tool.name, action })}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] font-medium capitalize hover:border-app-accent/40 disabled:opacity-50"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
            {serviceAction.isError ? (
              <p className="mt-2 text-[11px] text-app-danger">{serviceAction.error.message}</p>
            ) : null}
          </div>
        </Section>
      ) : activeTab === "overview" && tool.startupMode === "always-on" ? (
        <Section title="Service lifecycle">
          <p className="rounded-md border border-app-warning/30 bg-app-warning-soft px-3 py-2 text-xs text-app-warning">
            This tool declares an always-on startup mode, but no service status is currently registered.
          </p>
        </Section>
      ) : null}

      {activeTab === "overview" && tool.lastHealthDetail ? (
        <p className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs text-app-text-muted">
          Health: {truncate(tool.lastHealthDetail, 200)}
        </p>
      ) : null}

      {activeTab === "overview" ? (
        <Section title="Catalog status">
          <div className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-3">
              <Metric label="catalog layer" value={tool.catalogLayer} />
              <Metric
                label="agent eligibility"
                value={tool.agentEligibility.offered ? "offered" : "blocked"}
              />
              <Metric label="reason" value={tool.agentEligibility.reason} />
            </div>
            <p className="mt-2 text-[11px] text-app-text-muted">
              {tool.agentEligibility.detail}
            </p>
          </div>
        </Section>
      ) : null}

      {activeTab === "overview" && runtimeReadiness && (requiredKeys.length > 0 || requiredSecretHandles.length > 0) ? (
        <Section title="Runtime readiness">
          <ToolRuntimeReadinessPanel readiness={runtimeReadiness} />
        </Section>
      ) : null}

      {activeTab === "overview" && tool.source === "generated" ? (
        <Section title="Active for agents">
          <div className="rounded-md border border-app-accent/40 bg-app-accent-soft/20 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-sm font-semibold">v{tool.version}</p>
                <p className="mt-1 break-words text-[11px] text-app-text-muted">
                  {tool.packageManifest?.package?.type ?? "package"} ·{" "}
                  {tool.packageManifest?.package?.ref ?? "no package ref"}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <GenericBadge tone={statusTone(tool.status)}>{tool.status}</GenericBadge>
                {tool.status === "available" ? (
                  <GenericBadge tone={tool.agentEligibility.offered ? "ok" : "warn"}>
                    {tool.agentEligibility.offered ? "offered to agents" : "not offered"}
                  </GenericBadge>
                ) : (
                  <GenericBadge tone="muted">not offered to agents</GenericBadge>
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-app-text-muted">
              This is the version agents receive in their available-tool catalog. Use the
              Versions section only to verify, activate, or roll back inactive versions.
            </p>
            {newerInactiveVersions.length > 0 ? (
              <div className="mt-2 rounded-md border border-app-warning/40 bg-app-warning-soft px-2.5 py-2 text-[11px] text-app-warning">
                Newer inactive candidate{newerInactiveVersions.length === 1 ? "" : "s"} exist:{" "}
                <span className="font-mono">
                  {newerInactiveVersions.map((version) => `v${version.version}`).join(", ")}
                </span>
                . Agents still receive v{tool.version} until a candidate is manually verified and activated.
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {activeTab === "context" && tool.source === "generated" ? (
        <Section title="Current tool context">
          <ToolContextPanel toolName={tool.name} />
        </Section>
      ) : null}

      {activeTab === "overview" ? (
        <Section title="Usage">
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <Metric label="successful" value={String(tool.successCount ?? 0)} />
            <Metric label="failures" value={String(tool.failureCount ?? 0)} />
            <Metric
              label="success rate"
              value={formatSuccessRate(tool.successCount ?? 0, tool.failureCount ?? 0)}
            />
          </div>
          <p className="mt-2 text-[11px] text-app-text-muted">
            {tool.status === "available"
              ? "Available tools can be offered to BaseAgent when registered."
              : "Non-available tools remain inspectable and manually runnable, but are not offered to BaseAgent."}
          </p>
        </Section>
      ) : null}

      {activeTab === "overview" && (tool.capabilities ?? []).length > 0 ? (
        <Section title="Capabilities">
          <div className="flex flex-wrap gap-1.5">
            {(tool.capabilities ?? []).map((capability) => (
              <span
                key={capability}
                className="rounded-full bg-app-surface-2 px-2 py-0.5 text-[11px]"
              >
                {capability}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {activeTab === "settings" && requiredSecretHandles.length > 0 ? (
        <Section title="Required secret handles">
          <ToolSecretHandlePanel
            toolName={tool.name}
            handles={requiredSecretHandles}
            statuses={secretStatuses.data ?? []}
            isLoading={secretStatuses.isLoading}
            error={secretStatuses.isError ? secretStatuses.error.message : undefined}
          />
        </Section>
      ) : null}

      {activeTab === "settings" ? (
        <Section title="Runtime settings">
          {allKeys.length === 0 ? (
            <p className="text-xs text-app-text-muted">
              No declared settings or required configuration keys.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {allKeys.map((key) => (
                <RuntimeSettingRow
                  key={key}
                  toolName={tool.name}
                  settingKey={key}
                  schema={settingsSchema[key]}
                  isRequired={requiredKeys.includes(key)}
                  value={settings[key]}
                  isPending={setSetting.isPending || deleteSetting.isPending}
                  onSave={(value) => setSetting.mutate({ toolName: tool.name, key, value })}
                  onClear={() => deleteSetting.mutate({ toolName: tool.name, key })}
                />
              ))}
            </ul>
          )}
          {setSetting.isError ? (
            <p className="mt-2 text-[11px] text-app-danger">{setSetting.error.message}</p>
          ) : null}
        </Section>
      ) : null}

      {activeTab === "overview" && (tool.examples ?? []).length > 0 ? (
        <Section title="Examples">
          <ol className="space-y-2 text-xs">
            {(tool.examples ?? []).slice(0, 3).map((example, index) => (
              <li key={index} className="rounded-md border border-app-border bg-app-surface-2 p-2">
                <p className="font-medium">{example.title}</p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                  {JSON.stringify(example, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {activeTab === "overview" && tool.docsMarkdown ? (
        <Section title="Docs">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] text-app-text-muted">
            {tool.docsMarkdown}
          </pre>
        </Section>
      ) : null}

      {activeTab === "overview" ? (
        <Section title="Schemas">
          <details>
            <summary className="cursor-pointer text-xs text-app-text-muted">Input / output</summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
              {JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }, null, 2)}
            </pre>
          </details>
        </Section>
      ) : null}

      {activeTab === "run" ? (
        <Section title="Manual run">
          {/*
            Phase 13 follow-up: keying the panel on tool.name forces React
            to discard local state when the user clicks a different tool
            in the sidebar. Without the key, `useState(initialDraft)`
            locks in the draft text from the first-rendered tool and the
            textarea sticks on whatever example was loaded first — every
            subsequent tool selection looked identical even though
            `initialDraft` had recomputed.
          */}
          <ManualRunPanel key={tool.name} tool={tool} />
        </Section>
      ) : null}

      {activeTab === "edit" && tool.source === "generated" ? (
        <Section title="Request tool edit">
          <ToolEditPanel tool={tool} />
        </Section>
      ) : null}

      {activeTab === "versions" && tool.source === "generated" ? (
        <Section title="Versions">
          <VersionsPanel tool={tool} activeVersion={tool.version} />
        </Section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-app-border pt-3 text-[11px] text-app-text-muted">
        <span>updated {formatRelative(tool.updatedAt)}</span>
        <button
          type="button"
          onClick={() =>
            setStatus.mutate({
              name: tool.name,
              status: tool.status === "available" ? "disabled" : "available",
              previousStatus: tool.status,
            })
          }
          disabled={setStatus.isPending}
          className={[
            "rounded-md border px-2.5 py-1",
            tool.status === "available"
              ? "border-app-warning/40 bg-app-warning-soft text-app-warning"
              : "border-app-accent/40 bg-app-accent-soft text-app-accent",
          ].join(" ")}
        >
          {setStatus.isPending
            ? "Updating…"
            : tool.status === "available"
              ? "Disable for agent"
              : "Enable for agent"}
        </button>
        {setStatus.isError ? (
          <span className="text-app-danger">{setStatus.error.message}</span>
        ) : null}
        {tool.source === "generated" ? (
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(`Delete generated tool ${tool.name}?`)) return;
              deleteGenerated.mutate(tool.name);
            }}
            disabled={deleteGenerated.isPending}
            className="rounded-md border border-app-danger/40 bg-app-danger-soft px-2.5 py-1 text-app-danger"
          >
            {deleteGenerated.isPending ? "Deleting…" : "Delete generated tool"}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function ToolDetailTabs({
  tabs,
  activeTab,
  onSelect,
}: {
  tabs: Array<{ id: ToolDetailTabId; label: string }>;
  activeTab: ToolDetailTabId;
  onSelect: (tab: ToolDetailTabId) => void;
}) {
  return (
    <nav
      aria-label="Tool detail sections"
      className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto border-y border-app-border bg-app-surface/95 px-1 py-2 backdrop-blur"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={[
              "shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "border-app-accent bg-app-accent text-app-bg"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent/50 hover:text-app-text",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

export function ToolRuntimeReadinessPanel({
  readiness,
}: {
  readiness: NonNullable<ToolModuleMetadata["runtimeReadiness"]>;
}) {
  const blocked = !readiness.ok;
  return (
    <div
      className={[
        "rounded-md border p-3 text-xs",
        blocked
          ? "border-app-warning/40 bg-app-warning-soft/40"
          : "border-app-border bg-app-surface-2",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={blocked ? "font-semibold text-app-warning" : "font-semibold text-app-accent"}>
            {blocked ? "Runtime call is blocked" : "Runtime call is ready"}
          </p>
          <p className="mt-1 text-[11px] text-app-text-muted">{readiness.message}</p>
        </div>
        <GenericBadge tone={blocked ? "warn" : "ok"}>{readiness.status.replace(/_/g, " ")}</GenericBadge>
      </div>
      {readiness.missingConfigurationKeys.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-app-text-muted">Missing configuration</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {readiness.missingConfigurationKeys.map((key) => (
              <li key={key} className="rounded bg-app-surface px-1.5 py-0.5 font-mono text-[10px]">
                {key}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {readiness.missingSecretHandles.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-app-text-muted">Missing secret handles</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {readiness.missingSecretHandles.map((handle) => (
              <li key={handle} className="rounded bg-app-surface px-1.5 py-0.5 font-mono text-[10px]">
                {handle}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}


/**
 * Phase 13 follow-up: render the tool's input schema as a compact
 * field table so the operator can see what shape the runner expects
 * without having to expand the raw JSON schema dropdown above.
 * Falls back to a "no declared schema" hint when the tool's
 * inputSchema is empty.
 */
export function InputSchemaSummary({
  schema,
}: {
  schema?: ToolModuleMetadata["inputSchema"];
}) {
  const properties =
    schema && typeof schema === "object" && schema !== null
      ? ((schema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  const required = new Set(
    (schema && typeof schema === "object" && schema !== null
      ? ((schema as { required?: string[] }).required ?? [])
      : []) ?? [],
  );
  const entries = Object.entries(properties);

  return (
    <details className="rounded border border-app-border bg-app-surface px-2 py-1.5 open:bg-app-surface-2" open>
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        Input schema {entries.length > 0 ? `(${entries.length} field${entries.length === 1 ? "" : "s"})` : "(no declared properties)"}
      </summary>
      {entries.length === 0 ? (
        <p className="mt-1 text-[11px] text-app-text-muted">
          This tool doesn't declare an input schema. Pass any JSON object and the runtime will
          forward it as-is.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1 text-[11px]">
          {entries.map(([key, raw]) => {
            const def = raw as {
              type?: string | string[];
              description?: string;
              enum?: unknown[];
              minLength?: number;
              minimum?: number;
              maximum?: number;
              default?: unknown;
            };
            const type = Array.isArray(def?.type) ? def.type.join("|") : def?.type ?? "any";
            const constraints: string[] = [];
            if (Array.isArray(def?.enum) && def.enum.length > 0) {
              constraints.push(`enum: ${def.enum.map((v) => JSON.stringify(v)).join(", ")}`);
            }
            if (def?.minLength !== undefined) constraints.push(`minLen ${def.minLength}`);
            if (def?.minimum !== undefined) constraints.push(`min ${def.minimum}`);
            if (def?.maximum !== undefined) constraints.push(`max ${def.maximum}`);
            if (def?.default !== undefined) {
              constraints.push(`default: ${JSON.stringify(def.default).slice(0, 40)}`);
            }
            return (
              <li key={key} className="flex flex-col rounded bg-app-surface px-2 py-1">
                <span className="font-mono">
                  {key}
                  {required.has(key) ? <span className="ml-1 text-app-warning">*</span> : null}
                  <span className="ml-2 text-app-text-muted">: {type}</span>
                </span>
                {def?.description ? (
                  <span className="text-app-text-muted">{def.description}</span>
                ) : null}
                {constraints.length > 0 ? (
                  <span className="text-app-text-muted">{constraints.join(" · ")}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/**
 * Phase 13 follow-up: known realistic example payloads for the
 * built-in tools. The schema-driven generator produces a structurally
 * valid example, but for a few tools (browser.operate, file.write,
 * etc.) a domain-realistic command sequence is much more useful as
 * a starting point. Keyed by tool.name; falls back to schema-driven
 * generation when the tool isn't listed here.
 */

export function RuntimeSettingRow({
  toolName,
  settingKey,
  schema,
  isRequired,
  value,
  isPending,
  onSave,
  onClear,
}: {
  toolName: string;
  settingKey: string;
  schema?: { type?: string; description?: string; enum?: string[] };
  isRequired: boolean;
  value: string | undefined;
  isPending: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [touched, setTouched] = useState(false);
  const dirty = draft !== (value ?? "");

  return (
    <li className="rounded-md border border-app-border bg-app-surface-2 p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono">
            {settingKey}
            {isRequired ? <span className="ml-1 text-app-warning">*</span> : null}
          </p>
          {schema?.description ? (
            <p className="mt-0.5 text-[11px] text-app-text-muted">{schema.description}</p>
          ) : null}
        </div>
        <span className="font-mono text-[10px] text-app-text-muted">{toolName}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {Array.isArray(schema?.enum) ? (
          <select
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setTouched(true);
            }}
            className="flex-1 rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
          >
            <option value="">(unset)</option>
            {schema.enum.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setTouched(true);
            }}
            placeholder={schema?.type === "number" || schema?.type === "integer" ? "number" : "value"}
            className="flex-1 rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
          />
        )}
        <button
          type="button"
          disabled={!dirty || isPending || !draft}
          onClick={() => {
            onSave(draft);
            setTouched(false);
          }}
          className="rounded bg-app-accent px-2 py-0.5 font-semibold text-app-bg disabled:opacity-50"
        >
          Save
        </button>
        {value !== undefined ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              onClear();
              setDraft("");
              setTouched(false);
            }}
            className="rounded border border-app-border bg-app-surface px-2 py-0.5"
            title="Clear runtime override; the tool falls back to env / default."
          >
            Clear
          </button>
        ) : null}
      </div>
      {touched && !draft && isRequired ? (
        <p className="mt-1 text-[11px] text-app-warning">Required key.</p>
      ) : null}
    </li>
  );
}
