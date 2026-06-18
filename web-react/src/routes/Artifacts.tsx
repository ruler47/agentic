import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useDeleteArtifact, useRuns } from "@/api/runs";
import { flattenArtifactsFromRuns } from "@/api/conversations";
import { artifactDownloadUrl, ArtifactQualityBadge } from "@/components/ArtifactPreview";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";
import type { AgentArtifact, AgentRunRecord } from "@/api/types";

const KIND_FILTERS = ["all", "input", "output"] as const;

export function ArtifactsPage() {
  const runs = useRuns();
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [search, setSearch] = useState("");

  const all = useMemo(() => flattenArtifactsFromRuns(runs.data), [runs.data]);
  const filtered = useMemo(() => {
    return all.filter(({ artifact }) => {
      if (kind !== "all" && artifact.kind !== kind) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = [artifact.filename, artifact.mimeType, artifact.description, artifact.id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [all, kind, search]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold">Artifacts</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Files attached to runs (input) or produced by agents (output). Aggregated from
            <code className="mx-1">/api/runs</code>; preview cards link back to the originating run.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search filename, mime, description…"
            className="min-w-[220px] rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 outline-none focus:border-app-accent/60"
          />
          <div className="flex items-center gap-0.5 rounded-md border border-app-border bg-app-surface-2 p-0.5">
            {KIND_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={[
                  "rounded px-2 py-0.5 text-[11px]",
                  kind === value ? "bg-app-accent text-app-bg" : "text-app-text hover:bg-app-surface",
                ].join(" ")}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </header>
      <p className="text-[11px] text-app-text-muted">
        {filtered.length} of {all.length} artifacts.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(({ artifact, run }) => (
          <ArtifactCard key={artifact.id} artifact={artifact} run={run} />
        ))}
        {filtered.length === 0 && !runs.isLoading ? (
          <p className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-8 text-sm text-app-text-muted">
            No artifacts match the filters.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactCard({ artifact, run }: { artifact: AgentArtifact; run: AgentRunRecord }) {
  const isImage = artifact.mimeType?.startsWith("image/");
  const sizeKb = Math.max(0, Math.round((artifact.sizeBytes ?? 0) / 1024));
  const downloadUrl = artifactDownloadUrl(artifact.url);
  const deleteArtifact = useDeleteArtifact();
  const onDelete = () => {
    if (deleteArtifact.isPending) return;
    if (
      !window.confirm(
        `Delete artifact "${artifact.filename}"?\n\nThis removes the metadata row AND the underlying file from the object store. This action cannot be undone.`,
      )
    ) {
      return;
    }
    deleteArtifact.mutate({ runId: run.id, artifactId: artifact.id });
  };
  return (
    <article className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <strong className="break-all text-sm">{artifact.filename}</strong>
        <GenericBadge tone={artifact.kind === "output" ? "ok" : "muted"}>
          {artifact.kind}
        </GenericBadge>
      </div>
      <p className="font-mono text-[10px] text-app-text-muted">
        {artifact.mimeType} · {sizeKb} KB · {formatRelative(artifact.createdAt)}
      </p>
      {isImage ? (
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="overflow-hidden rounded-md border border-app-border bg-app-surface-2"
        >
          <img
            src={artifact.url}
            alt={artifact.filename}
            loading="lazy"
            className="h-40 w-full object-cover"
          />
        </a>
      ) : artifact.contentPreview ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-app-border bg-app-surface-2 px-2 py-1 font-mono text-[10px]">
          {truncate(artifact.contentPreview, 600)}
        </pre>
      ) : null}
      {artifact.description ? (
        <p className="text-[11px] text-app-text-muted">{truncate(artifact.description, 200)}</p>
      ) : null}
      <ArtifactQualityBadge quality={artifact.quality} />
      <div className="mt-1 flex flex-wrap gap-2">
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40"
        >
          {isImage ? "Preview" : "Open"}
        </a>
        <a
          href={downloadUrl}
          download={artifact.filename}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] hover:border-app-accent/40"
        >
          Download
        </a>
        <Link
          to={`/run/${run.id}`}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px]"
        >
          Run
        </Link>
        <Link
          to={`/trace/${run.id}`}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px]"
        >
          Trace
        </Link>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteArtifact.isPending}
          className="ml-auto rounded-md border border-app-danger/40 bg-app-danger-soft px-2.5 py-1 text-[11px] text-app-danger hover:border-app-danger/60 disabled:opacity-50"
          title="Delete this artifact (metadata + underlying object). Cannot be undone."
        >
          {deleteArtifact.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
      {deleteArtifact.isError ? (
        <p className="text-[11px] text-app-danger">Delete failed: {deleteArtifact.error.message}</p>
      ) : null}
    </article>
  );
}
