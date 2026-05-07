import { useMemo, useState } from "react";

import {
  settingsByTool,
  useDeleteGeneratedTool,
  useDeleteToolSetting,
  useReloadGeneratedTools,
  useRunToolHealthchecks,
  useSetToolSetting,
  useToolPackageRunners,
  useToolSettings,
  useTools,
} from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { ToolModuleMetadata } from "@/api/types";

export function ToolsPage() {
  const tools = useTools();
  const toolSettings = useToolSettings();
  const packageRunners = useToolPackageRunners();
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
                    <GenericBadge tone={statusTone(tool.status)}>{tool.status}</GenericBadge>
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
}: {
  tool: ToolModuleMetadata;
  settings: Record<string, string>;
}) {
  const setSetting = useSetToolSetting();
  const deleteSetting = useDeleteToolSetting();
  const deleteGenerated = useDeleteGeneratedTool();

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
        </div>
      </header>

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
