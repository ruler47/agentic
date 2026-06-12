import { useMemo, useState } from "react";

import {
  settingsByTool,
  useReloadGeneratedTools,
  useRunToolHealthchecks,
  useToolCreations,
  useToolPackageRunners,
  useToolSettings,
  useTools,
} from "@/api/tools";
import { useToolServices } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { CandidateReviewQueue } from "@/features/tools-page/CandidateReviewQueue";
import { CreateToolPackagePanel } from "@/features/tools-page/ToolForms";
import { ToolCreationsPanel } from "@/features/tools-page/ToolCreationsPanel";
import { ToolDetail } from "@/features/tools-page/ToolDetail";
import { PackageRunnersPanel, serviceTone, statusTone } from "@/features/tools-page/toolsPageShared";

export function ToolsPage() {
  const tools = useTools();
  const toolSettings = useToolSettings();
  const packageRunners = useToolPackageRunners();
  const toolCreations = useToolCreations();
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
        <CreateToolPackagePanel
          onCreated={(name) => {
            setSelected(name);
            setSearch("");
          }}
        />
        <ToolListPanel
          tools={filteredTools}
          selectedToolName={selectedTool?.name}
          serviceMap={serviceMap}
          isLoading={tools.isLoading}
          onSelect={(name) => setSelected(name)}
        />
        <CandidateReviewQueue
          tools={tools.data ?? []}
          onSelectTool={(name) => {
            setSelected(name);
            setSearch("");
          }}
        />
        <ToolCreationsPanel
          creations={toolCreations.data}
          onSelectTool={(name) => {
            setSelected(name);
            setSearch("");
          }}
        />
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

function ToolListPanel({
  tools,
  selectedToolName,
  serviceMap,
  isLoading,
  onSelect,
}: {
  tools: NonNullable<ReturnType<typeof useTools>["data"]>;
  selectedToolName?: string;
  serviceMap: Map<string, NonNullable<ReturnType<typeof useToolServices>["data"]>[number]>;
  isLoading: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-2">
      <div className="mb-2 flex items-center justify-between px-1 text-xs">
        <h3 className="font-semibold">Tool registry</h3>
        <span className="text-[10px] text-app-text-muted">{tools.length} tools</span>
      </div>
      <ul className="flex flex-col gap-1">
        {isLoading ? (
          <li className="px-2 py-3 text-xs text-app-text-muted">Loading tools…</li>
        ) : tools.length === 0 ? (
          <li className="px-2 py-3 text-xs text-app-text-muted">No tools match.</li>
        ) : (
          tools.map((tool) => (
            <li key={tool.name}>
              <button
                type="button"
                onClick={() => onSelect(tool.name)}
                className={[
                  "w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                  tool.name === selectedToolName
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
    </section>
  );
}
