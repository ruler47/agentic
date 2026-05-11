import { useEffect, useMemo, useState } from "react";

import {
  settingsByTool,
  useActivateToolVersion,
  useDeleteGeneratedTool,
  useDeleteToolSetting,
  useReloadGeneratedTools,
  useRunToolHealthchecks,
  useRunToolManually,
  useSetToolSetting,
  useToolPackageRunners,
  useToolSettings,
  useTools,
  useToolVersions,
  type ManualToolRunResponse,
  type ToolVersionSummary,
} from "@/api/tools";
import { useCreateToolBuildRun } from "@/api/toolBuildRuns";
import { useToolServiceAction, useToolServices } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolModuleMetadata, ToolServiceStatus } from "@/api/types";

export function ToolsPage() {
  const tools = useTools();
  const toolSettings = useToolSettings();
  const packageRunners = useToolPackageRunners();
  const toolServices = useToolServices();
  const reload = useReloadGeneratedTools();
  const runHealth = useRunToolHealthchecks();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | undefined>();

  const filteredTools = useMemo(() => {
    const list = tools.data ?? [];
    if (!search.trim()) return list;
    const needle = search.trim().toLowerCase();
    return list.filter((tool) => {
      const haystack = [
        tool.name,
        tool.displayName,
        tool.description,
        tool.version,
        tool.source,
        tool.status,
        ...(tool.capabilities ?? []),
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join(" ");
      return haystack.includes(needle);
    });
  }, [tools.data, search]);

  const settingsMap = useMemo(() => settingsByTool(toolSettings.data), [toolSettings.data]);
  const serviceMap = useMemo(
    () => new Map((toolServices.data ?? []).map((service) => [service.toolName, service])),
    [toolServices.data],
  );
  const selectedTool = filteredTools.find((tool) => tool.name === selected) ?? filteredTools[0];

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3">
        <header className="flex items-center justify-between gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools…"
            className="w-full rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
          />
        </header>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => runHealth.mutate()}
            disabled={runHealth.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1"
          >
            {runHealth.isPending ? "Checking…" : "Run healthchecks"}
          </button>
          <button
            type="button"
            onClick={() => reload.mutate()}
            disabled={reload.isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1"
          >
            {reload.isPending ? "Reloading…" : "Reload generated tools"}
          </button>
        </div>
        <ul className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-2">
          {tools.isLoading ? (
            <li className="px-2 py-3 text-xs text-app-text-muted">Loading tools…</li>
          ) : filteredTools.length === 0 ? (
            <li className="px-2 py-3 text-xs text-app-text-muted">No tools match.</li>
          ) : (
            filteredTools.map((tool) => (
              <li key={tool.name}>
                <button
                  type="button"
                  onClick={() => setSelected(tool.name)}
                  className={[
                    "w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                    tool.name === selectedTool?.name
                      ? "border-app-accent bg-app-accent-soft/40"
                      : "border-transparent hover:border-app-border hover:bg-app-surface-2",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate">{tool.displayName ?? tool.name}</strong>
                    <div className="flex shrink-0 items-center gap-1">
                      <GenericBadge tone={statusTone(tool.status)}>{tool.status}</GenericBadge>
                      {serviceMap.has(tool.name) ? (
                        <GenericBadge tone={serviceTone(serviceMap.get(tool.name)?.status)}>
                          {serviceMap.get(tool.name)?.status}
                        </GenericBadge>
                      ) : null}
                    </div>
                  </div>
                  <p className="truncate font-mono text-[10px] text-app-text-muted">
                    {tool.name} · v{tool.version}
                  </p>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-app-text-muted">
                    {(tool.capabilities ?? []).slice(0, 3).map((capability) => (
                      <span key={capability} className="rounded-full bg-app-surface-2 px-1.5 py-0.5">
                        {capability}
                      </span>
                    ))}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
        <PackageRunnersPanel runners={packageRunners.data} />
      </aside>

      <div className="min-w-0">
        {selectedTool ? (
          <ToolDetail
            tool={selectedTool}
            settings={settingsMap.get(selectedTool.name) ?? {}}
            service={serviceMap.get(selectedTool.name)}
          />
        ) : (
          <div className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-8 text-sm text-app-text-muted">
            Select a tool from the list to inspect its schemas, runtime settings, and credentials.
          </div>
        )}
      </div>
    </section>
  );
}

function ToolDetail({
  tool,
  settings,
  service,
}: {
  tool: ToolModuleMetadata;
  settings: Record<string, string>;
  service?: ToolServiceStatus;
}) {
  const setSetting = useSetToolSetting();
  const deleteSetting = useDeleteToolSetting();
  const deleteGenerated = useDeleteGeneratedTool();
  const serviceAction = useToolServiceAction();

  const requiredKeys = tool.requiredConfigurationKeys ?? [];
  const requiredSecretHandles = tool.requiredSecretHandles ?? [];
  const settingsSchema = (tool.settingsSchema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: string[] }
  >;
  const allKeys = Array.from(new Set([
    ...Object.keys(settingsSchema),
    ...requiredKeys,
    ...Object.keys(settings),
  ]));

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
          {typeof tool.lastHealthOk === "boolean" ? (
            <GenericBadge tone={tool.lastHealthOk ? "ok" : "danger"}>
              {tool.lastHealthOk ? "healthy" : "unhealthy"}
            </GenericBadge>
          ) : null}
          {service ? (
            <GenericBadge tone={serviceTone(service.status)}>
              service {service.status}
            </GenericBadge>
          ) : null}
        </div>
      </header>

      {service ? (
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
      ) : tool.startupMode === "always-on" ? (
        <Section title="Service lifecycle">
          <p className="rounded-md border border-app-warning/30 bg-app-warning-soft px-3 py-2 text-xs text-app-warning">
            This tool declares an always-on startup mode, but no service status is currently registered.
          </p>
        </Section>
      ) : null}

      {tool.lastHealthDetail ? (
        <p className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs text-app-text-muted">
          Health: {truncate(tool.lastHealthDetail, 200)}
        </p>
      ) : null}

      {(tool.capabilities ?? []).length > 0 ? (
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

      {requiredSecretHandles.length > 0 ? (
        <Section title="Required secret handles">
          <ul className="flex flex-wrap gap-1.5 text-[11px] font-mono text-app-text-muted">
            {requiredSecretHandles.map((handle) => (
              <li key={handle} className="rounded-full bg-app-surface-2 px-2 py-0.5">
                {handle}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

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

      {(tool.examples ?? []).length > 0 ? (
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

      {tool.docsMarkdown ? (
        <Section title="Docs">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] text-app-text-muted">
            {tool.docsMarkdown}
          </pre>
        </Section>
      ) : null}

      <Section title="Schemas">
        <details>
          <summary className="cursor-pointer text-xs text-app-text-muted">Input / output</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
            {JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }, null, 2)}
          </pre>
        </details>
      </Section>

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

      {tool.source === "generated" ? (
        <Section title="Versions">
          <VersionsPanel toolName={tool.name} activeVersion={tool.version} />
        </Section>
      ) : null}

      {tool.source === "generated" ? (
        <Section title="Request changes">
          <RequestChangesPanel tool={tool} />
        </Section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-app-border pt-3 text-[11px] text-app-text-muted">
        <span>updated {formatRelative(tool.updatedAt)}</span>
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

/**
 * Phase 13 follow-up: render the tool's input schema as a compact
 * field table so the operator can see what shape the runner expects
 * without having to expand the raw JSON schema dropdown above.
 * Falls back to a "no declared schema" hint when the tool's
 * inputSchema is empty.
 */
function InputSchemaSummary({
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
const TOOL_RUN_EXAMPLES: Record<string, unknown> = {
  "browser.operate": {
    commands: [
      { type: "navigate", url: "https://example.com" },
      { type: "screenshot", label: "demo", maxHeight: 2000 },
      { type: "extractText", selector: "body", label: "page-text", maxLength: 1500 },
    ],
    viewport: { width: 1280, height: 800 },
    defaultTimeoutMs: 15000,
  },
  "chart.generate": {
    task: "покажи график изменения цены",
    text: '{"history":[{"timestamp":"2024-01-01","price":100},{"timestamp":"2024-01-02","price":110},{"timestamp":"2024-01-03","price":95},{"timestamp":"2024-01-04","price":130}]}',
    title: "Demo Price Chart",
    filename: "demo-chart.svg",
  },
  "market.timeseries": { symbol: "BTC", vsCurrency: "usd", days: 30 },
  "web.search": { query: "what is an agentic universal agent", limit: 5 },
  "file.read": { path: "manual-checks" },
  "file.write": { path: "manual-test/hello.txt", content: "hello from manual run\n" },
  "telegram.bot": {},
};

/**
 * Phase 13 follow-up: walk a JSON Schema and produce a structurally
 * valid example object. Recurses into nested object/array schemas,
 * uses `default` / `enum[0]` / `minimum` / `minLength` hints when
 * available, and falls back to type-driven placeholders ("example
 * string", 0, false, []) otherwise. Returns `{}` for an empty
 * schema. Pure function — easy to unit-test if it grows.
 */
function buildSchemaExample(schema: unknown, toolName?: string): unknown {
  if (toolName && Object.prototype.hasOwnProperty.call(TOOL_RUN_EXAMPLES, toolName)) {
    return TOOL_RUN_EXAMPLES[toolName];
  }
  return buildExampleForSchema(schema);
}

function buildExampleForSchema(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return {};
  const schema = raw as {
    type?: string | string[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    enum?: unknown[];
    default?: unknown;
    minimum?: number;
    minLength?: number;
  };
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    // Prefer required keys first, then a small slice of optional keys for context.
    const orderedKeys = [
      ...Object.keys(props).filter((k) => required.has(k)),
      ...Object.keys(props).filter((k) => !required.has(k)),
    ];
    for (const key of orderedKeys.slice(0, 8)) {
      out[key] = buildExampleForSchema(props[key]);
    }
    return out;
  }
  if (type === "array") {
    const itemSchema = schema.items;
    return itemSchema !== undefined ? [buildExampleForSchema(itemSchema)] : [];
  }
  if (type === "number" || type === "integer") {
    if (typeof schema.minimum === "number") return schema.minimum;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "string") {
    if (typeof schema.minLength === "number" && schema.minLength > 0) {
      return "example";
    }
    return "example string";
  }
  return null;
}

/**
 * Phase 13 follow-up: manual tool runner panel. Lets the operator paste a
 * JSON `input`, click "Run", and see the exact `ToolResult` the runtime
 * would hand back to an agent. Useful for smoke-testing a fresh docker
 * build / a new version before promoting it. Pre-fills the textarea
 * with a realistic example built from the tool's declared input schema
 * (or a hand-tuned payload from `TOOL_RUN_EXAMPLES`) on mount.
 */
function ManualRunPanel({ tool }: { tool: ToolModuleMetadata }) {
  const run = useRunToolManually();
  const initialDraft = useMemo(() => {
    const example = tool.examples?.[0];
    if (example?.input && typeof example.input === "object") {
      return JSON.stringify(example.input, null, 2);
    }
    return JSON.stringify(buildSchemaExample(tool.inputSchema, tool.name), null, 2);
  }, [tool]);
  const [draft, setDraft] = useState(initialDraft);
  const [parseError, setParseError] = useState<string | undefined>();

  const submit = () => {
    setParseError(undefined);
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(draft || "{}");
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Input must be a JSON object.");
      }
      parsed = candidate as Record<string, unknown>;
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Invalid JSON");
      return;
    }
    run.mutate({ name: tool.name, input: parsed });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <InputSchemaSummary schema={tool.inputSchema} />
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-app-text-muted">
          Input (JSON object matching the tool's input schema)
        </span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          spellCheck={false}
          className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-app-accent/60"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={run.isPending}
          className="rounded bg-app-accent px-3 py-1 font-semibold text-app-bg disabled:opacity-50"
        >
          {run.isPending ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(initialDraft);
            setParseError(undefined);
            run.reset();
          }}
          disabled={run.isPending}
          className="rounded border border-app-border bg-app-surface px-2.5 py-1 disabled:opacity-50"
        >
          Reset
        </button>
        {parseError ? (
          <span className="text-app-danger">{parseError}</span>
        ) : run.isError ? (
          <span className="text-app-danger">{run.error.message}</span>
        ) : null}
      </div>
      {run.data ? <ManualRunResultDisplay response={run.data} /> : null}
    </div>
  );
}

function ManualRunResultDisplay({ response }: { response: ManualToolRunResponse }) {
  const { result, durationMs, tool } = response;
  const artifacts = useMemo(() => collectArtifacts(result.data), [result.data]);
  return (
    <div className="mt-1 rounded border border-app-border bg-app-surface p-2 text-[11px]">
      <p className="flex flex-wrap items-center gap-2">
        <GenericBadge tone={result.ok ? "ok" : "danger"}>{result.ok ? "ok" : "failed"}</GenericBadge>
        <span className="font-mono text-app-text-muted">
          {tool.name} v{tool.version} · {durationMs}ms
        </span>
      </p>
      <p className="mt-1.5 font-semibold">content:</p>
      <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
        {result.content || "(empty)"}
      </pre>
      {artifacts.length > 0 ? (
        <div className="mt-1.5">
          <p className="font-semibold">artifacts:</p>
          <ul className="mt-0.5 flex flex-col gap-1">
            {artifacts.map((artifact, index) => (
              <ArtifactDownloadRow key={`${artifact.filename}-${index}`} artifact={artifact} />
            ))}
          </ul>
        </div>
      ) : null}
      {result.data !== undefined ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-app-text-muted">data</summary>
          <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Phase 13 follow-up: artifact-shaped payload extracted from a manual
 * tool-run response. Tools return their files under a few different
 * keys (`data.artifact`, `data.screenshots[]`, `data.artifacts[]`, …),
 * with either inline string content or base64. `collectArtifacts`
 * recursively walks the response and surfaces every artifact-shaped
 * object so the UI can render one download button per file.
 */
type ManualRunArtifact = {
  filename: string;
  mimeType: string;
  content?: string;
  contentBase64?: string;
  description?: string;
};

function collectArtifacts(value: unknown): ManualRunArtifact[] {
  const out: ManualRunArtifact[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const candidate = node as Record<string, unknown>;
    const filename = typeof candidate.filename === "string" ? candidate.filename : undefined;
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : undefined;
    const inlineContent =
      typeof candidate.content === "string" ? (candidate.content as string) : undefined;
    const base64 =
      typeof candidate.contentBase64 === "string" ? (candidate.contentBase64 as string) : undefined;
    if (filename && mimeType && (inlineContent !== undefined || base64 !== undefined)) {
      out.push({
        filename,
        mimeType,
        content: inlineContent,
        contentBase64: base64,
        description: typeof candidate.description === "string" ? (candidate.description as string) : undefined,
      });
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return out;
}

function ArtifactDownloadRow({ artifact }: { artifact: ManualRunArtifact }) {
  const href = useMemo(() => {
    if (artifact.contentBase64) {
      return `data:${artifact.mimeType};base64,${artifact.contentBase64}`;
    }
    if (artifact.content !== undefined) {
      const blob = new Blob([artifact.content], { type: artifact.mimeType });
      return URL.createObjectURL(blob);
    }
    return undefined;
  }, [artifact]);

  // Revoke the object URL when the row unmounts so we don't leak.
  useEffect(() => {
    return () => {
      if (href && href.startsWith("blob:")) URL.revokeObjectURL(href);
    };
  }, [href]);

  const sizeHint = useMemo(() => {
    if (artifact.contentBase64) {
      // Base64 → bytes ≈ length * 3/4 (minus padding).
      const padding = (artifact.contentBase64.match(/=+$/) ?? [""])[0]!.length;
      return Math.max(0, Math.floor((artifact.contentBase64.length * 3) / 4) - padding);
    }
    if (artifact.content !== undefined) {
      try {
        return new TextEncoder().encode(artifact.content).length;
      } catch {
        return artifact.content.length;
      }
    }
    return undefined;
  }, [artifact]);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-app-border bg-app-surface-2 px-2 py-1">
      <span className="font-mono text-[10px]">{artifact.filename}</span>
      <span className="text-[10px] text-app-text-muted">
        {artifact.mimeType}
        {sizeHint !== undefined ? ` · ${formatBytes(sizeHint)}` : ""}
      </span>
      {artifact.description ? (
        <span className="text-[10px] text-app-text-muted">{artifact.description}</span>
      ) : null}
      {href ? (
        <a
          href={href}
          download={artifact.filename}
          className="ml-auto rounded bg-app-accent px-2 py-0.5 text-[10px] font-semibold text-app-bg hover:opacity-90"
        >
          Download
        </a>
      ) : (
        <span className="ml-auto text-[10px] text-app-text-muted">no content</span>
      )}
    </li>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function RuntimeSettingRow({
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

function PackageRunnersPanel({ runners }: { runners: ReturnType<typeof useToolPackageRunners>["data"] }) {
  if (!runners || runners.length === 0) return null;
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        Package Runners
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {runners.map((runner) => (
          <li key={runner.name} className="flex items-center justify-between gap-2">
            <span className="font-mono">{runner.name}</span>
            <GenericBadge tone={runner.status === "available" ? "ok" : runner.status === "failed" ? "danger" : "muted"}>
              {runner.status}
            </GenericBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function statusTone(status?: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "available") return "ok";
  if (status === "disabled") return "muted";
  if (status === "failed") return "danger";
  return "muted";
}

function serviceTone(status?: string): "ok" | "warn" | "danger" | "muted" | "running" {
  if (status === "running") return "running";
  if (status === "starting") return "warn";
  if (status === "failed") return "danger";
  return "muted";
}

/**
 * Phase 14 / Phase E follow-up: per-tool version history. Postgres
 * preserves every promoted version (change_summary, success/failure
 * counts, last health detail, updated_at) — surfaces it as a
 * scannable list with a one-click "Activate" affordance on inactive
 * versions so the operator can roll back without leaving the page.
 */
function VersionsPanel({
  toolName,
  activeVersion,
}: {
  toolName: string;
  activeVersion: string;
}) {
  const versionsQuery = useToolVersions(toolName);
  const activate = useActivateToolVersion();

  if (versionsQuery.isLoading) {
    return <p className="text-xs text-app-text-muted">Loading versions…</p>;
  }
  const versions = versionsQuery.data ?? [];
  if (versions.length === 0) {
    return <p className="text-xs text-app-text-muted">No version history.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {versions.map((version) => (
          <VersionRow
            key={version.version}
            toolName={toolName}
            version={version}
            isActive={version.version === activeVersion}
            onActivate={() => activate.mutate({ name: toolName, version: version.version })}
            isPending={activate.isPending}
          />
        ))}
      </ul>
      {activate.isError ? (
        <p className="text-[11px] text-app-danger">{activate.error.message}</p>
      ) : null}
    </div>
  );
}

function VersionRow({
  toolName: _toolName,
  version,
  isActive,
  onActivate,
  isPending,
}: {
  toolName: string;
  version: ToolVersionSummary;
  isActive: boolean;
  onActivate: () => void;
  isPending: boolean;
}) {
  const success = version.successCount ?? 0;
  const failure = version.failureCount ?? 0;
  const total = success + failure;
  return (
    <li
      className={[
        "rounded-md border p-3 text-xs",
        isActive
          ? "border-app-accent bg-app-accent-soft/30"
          : "border-app-border bg-app-surface-2",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[13px] font-semibold">v{version.version}</span>
          <GenericBadge tone={statusTone(version.status)}>{version.status}</GenericBadge>
          {isActive ? (
            <GenericBadge tone="ok">active</GenericBadge>
          ) : null}
          <span className="text-app-text-muted">
            promoted {formatRelative(version.updatedAt)}
          </span>
        </div>
        {!isActive ? (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Activate v${version.version}? The current active version will become inactive.`,
                )
              ) {
                onActivate();
              }
            }}
            disabled={isPending}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40 disabled:opacity-50"
          >
            {isPending ? "Activating…" : "Activate"}
          </button>
        ) : null}
      </div>
      {version.changeSummary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-app-text">
          {version.changeSummary}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-app-text-muted">
        {total > 0 ? (
          <>
            <span>runs: {total}</span>
            <span className="text-app-accent">{success} ok</span>
            <span className="text-app-danger">{failure} failed</span>
            <span>
              ({total > 0 ? Math.round((success / total) * 100) : 0}% success)
            </span>
          </>
        ) : (
          <span>no runs recorded</span>
        )}
        {version.lastHealthDetail ? (
          <span className="text-app-text-muted">
            health: {truncate(version.lastHealthDetail, 80)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Phase 14 / Phase E follow-up: in-place "Request changes" form for a
 * registered tool. Posts to /api/tool-build-runs with
 * `existingToolName` + `bugContext` so the council treats it as a
 * rework (kept the original tool name, bumps the version). Accepts
 * the same reference-doc attachments as the create flow — operator
 * can drop in updated OpenAPI specs or bug repro PDFs.
 */
function RequestChangesPanel({ tool }: { tool: ToolModuleMetadata }) {
  const create = useCreateToolBuildRun();
  const [bugContext, setBugContext] = useState("");
  const [qaCriteriaText, setQaCriteriaText] = useState("");
  const [references, setReferences] = useState<
    Array<{ filename: string; mimeType: string; size: number; contentBase64: string }>
  >([]);
  const [referenceError, setReferenceError] = useState<string | undefined>();
  const [open, setOpen] = useState(false);

  const onFilesPicked = async (files: FileList | null) => {
    setReferenceError(undefined);
    if (!files) return;
    const REFERENCE_FILE_CAP_MB = 5;
    const next: Array<{ filename: string; mimeType: string; size: number; contentBase64: string }> = [];
    for (const file of Array.from(files)) {
      if (file.size > REFERENCE_FILE_CAP_MB * 1024 * 1024) {
        setReferenceError(`${file.name}: exceeds ${REFERENCE_FILE_CAP_MB} MB cap.`);
        return;
      }
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      let binary = "";
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      next.push({
        filename: file.name,
        mimeType: file.type || guessMimeFromName(file.name),
        size: file.size,
        contentBase64: btoa(binary),
      });
    }
    setReferences((prev) => [...prev, ...next]);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending || !bugContext.trim()) return;
    const qaCriteria = qaCriteriaText
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    create.mutate(
      {
        name: tool.name,
        description: tool.description,
        existingToolName: tool.name,
        bugContext: bugContext.trim(),
        qaCriteria: qaCriteria.length > 0 ? qaCriteria : undefined,
        references: references.length > 0
          ? references.map((ref) => ({
              filename: ref.filename,
              mimeType: ref.mimeType,
              contentBase64: ref.contentBase64,
            }))
          : undefined,
      },
      {
        onSuccess: () => {
          setBugContext("");
          setQaCriteriaText("");
          setReferences([]);
          setReferenceError(undefined);
          setOpen(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-app-text-muted">
          Describe what should change and (optionally) attach updated docs. The council
          treats this as a rework: same tool name, bumped version, change summary written
          to the next version.
        </p>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px]"
        >
          {open ? "Close" : "Open form"}
        </button>
      </div>
      {open ? (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              What should change? (bug report, new field, broken edge case…)
            </span>
            <textarea
              required
              rows={4}
              value={bugContext}
              onChange={(event) => setBugContext(event.target.value)}
              placeholder="The /hourly endpoint now returns precipitation_probability; the tool ignores it."
              className="resize-y rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Additional QA criteria (one per line, optional)
            </span>
            <textarea
              rows={3}
              value={qaCriteriaText}
              onChange={(event) => setQaCriteriaText(event.target.value)}
              placeholder="precipitation_probability appears in the output for each hour"
              className="resize-y rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
            />
          </label>
          <fieldset className="flex flex-col gap-2 rounded-md border border-app-border bg-app-surface p-2">
            <legend className="text-[10px] uppercase tracking-wider text-app-text-muted">
              Reference docs (optional)
            </legend>
            <input
              type="file"
              multiple
              onChange={(event) => void onFilesPicked(event.target.files)}
              className="text-[11px] file:mr-3 file:rounded-md file:border file:border-app-border file:bg-app-surface-2 file:px-3 file:py-1 file:text-[11px] file:text-app-text"
            />
            {references.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[11px]">
                {references.map((ref) => (
                  <li
                    key={ref.filename}
                    className="flex items-center justify-between gap-2 rounded border border-app-border bg-app-surface-2 px-2 py-1"
                  >
                    <span className="min-w-0 truncate font-mono">
                      {ref.filename}
                      <span className="ml-2 text-app-text-muted">
                        {formatFileSize(ref.size)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setReferences((prev) => prev.filter((r) => r.filename !== ref.filename))
                      }
                      className="rounded text-app-text-muted hover:text-app-danger"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {referenceError ? (
              <p className="text-[11px] text-app-danger">{referenceError}</p>
            ) : null}
          </fieldset>
          {create.isError ? (
            <p className="text-[11px] text-app-danger">{create.error.message}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending || !bugContext.trim()}
              className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
            >
              {create.isPending ? "Starting rework…" : "Start rework build"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function guessMimeFromName(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "yaml":
    case "yml":
      return "application/yaml";
    case "json":
      return "application/json";
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "openapi":
      return "application/openapi+yaml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
