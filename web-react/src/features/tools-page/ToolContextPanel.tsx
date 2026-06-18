import { useState } from "react";

import {
  useCreateToolContext,
  useDeleteToolContext,
  useToolContext,
  useUpdateToolContext,
} from "@/api/tools";
import type { ToolContextKind, ToolContextRecord } from "@/api/types";
import { formatRelative } from "@/lib/format";
import { readToolContextFiles } from "./toolContextFiles";

const KINDS: ToolContextKind[] = [
  "documentation",
  "api-docs",
  "openapi",
  "docs-url",
  "file",
  "note",
  "qa-example",
];

export function ToolContextPanel({ toolName }: { toolName: string }) {
  const context = useToolContext(toolName);
  const create = useCreateToolContext();
  const update = useUpdateToolContext();
  const remove = useDeleteToolContext();
  const [draft, setDraft] = useState(defaultDraft());
  const [editingId, setEditingId] = useState<string | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const contextItems = sortContextItems(context.data ?? []);

  const uploadFiles = async (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    setUploadError(undefined);
    setUploading(true);
    try {
      const items = await readToolContextFiles(selected, 20);
      if (items.length === 0) {
        setUploadError("Selected files are empty or unreadable as text.");
        return;
      }
      for (const input of items) {
        await create.mutateAsync({ name: toolName, input });
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Failed to upload context files.");
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!draft.content.trim()) {
      window.alert("Context content is required.");
      return;
    }
    const input = {
      kind: draft.kind,
      title: draft.title.trim() || undefined,
      content: draft.content.trim(),
      source: draft.source.trim() || undefined,
      mimeType: draft.mimeType.trim() || undefined,
    };
    if (editingId) {
      update.mutate({ name: toolName, id: editingId, input }, {
        onSuccess: () => {
          setEditingId(undefined);
          setDraft(defaultDraft());
          setFormOpen(false);
        },
      });
      return;
    }
    create.mutate({ name: toolName, input }, {
      onSuccess: () => {
        setDraft(defaultDraft());
        setFormOpen(false);
      },
    });
  };

  const startEdit = (record: ToolContextRecord) => {
    setEditingId(record.id);
    setDraft({
      kind: record.kind,
      title: record.title,
      content: record.content,
      source: record.source ?? "",
      mimeType: record.mimeType ?? "",
    });
    setFormOpen(true);
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-[11px] text-app-text-muted">
        <p>
          These entries are the editable context passed into future tool edits: docs, files,
          links, OpenAPI specs, QA notes, and build history.
        </p>
        <p className="mt-1 font-mono">{contextItems.length} context item(s)</p>
      </div>

      {context.isLoading ? (
        <p className="text-app-text-muted">Loading context…</p>
      ) : contextItems.length === 0 ? (
        <p className="text-app-text-muted">
          No stored tool context yet. New edits will currently rely only on package metadata and request fields.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contextItems.map((record) => (
            <li key={record.id} className="rounded-md border border-app-border bg-app-surface-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{record.title}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-app-text-muted">
                    {record.kind} · updated {formatRelative(record.updatedAt)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => startEdit(record)} className="rounded border border-app-border px-2 py-1">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete context "${record.title}"?`)) {
                        remove.mutate({ name: toolName, id: record.id });
                      }
                    }}
                    className="rounded border border-app-danger/40 px-2 py-1 text-app-danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {record.source ? <p className="mt-1 break-all text-[11px] text-app-text-muted">{record.source}</p> : null}
              <button
                type="button"
                onClick={() => setExpandedIds((current) => toggleExpanded(current, record.id))}
                className="mt-2 rounded border border-app-border bg-app-surface px-2 py-1 text-[11px] font-medium text-app-accent"
              >
                {expandedIds.has(record.id) ? "Hide content" : "View content"}
              </button>
              {expandedIds.has(record.id) ? (
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-app-text-muted">
                  {record.content}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!formOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setEditingId(undefined);
              setDraft(defaultDraft());
              setFormOpen(true);
            }}
            className="rounded bg-app-accent px-3 py-1.5 font-semibold text-app-bg"
          >
            Add context item
          </button>
          <label className="rounded border border-app-border bg-app-surface-2 px-3 py-1.5 font-semibold text-app-text">
            <span>{uploading ? "Uploading…" : "Upload files"}</span>
            <input
              type="file"
              multiple
              accept=".yaml,.yml,.json,.md,.txt,.openapi"
              disabled={uploading}
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = "";
              }}
              className="sr-only"
            />
          </label>
          <span className="text-[11px] text-app-text-muted">
            YAML, JSON, Markdown, and text files are stored as editable tool context.
          </span>
        </div>
      ) : null}

      {uploadError ? <p className="text-[11px] text-app-danger">{uploadError}</p> : null}

      {formOpen ? (
        <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold">
              {editingId ? "Edit context item" : "Add context item"}
            </p>
            {!editingId ? (
              <label className="rounded border border-app-border bg-app-surface px-3 py-1.5 font-semibold text-app-text">
                <span>{uploading ? "Uploading…" : "Upload files"}</span>
                <input
                  type="file"
                  multiple
                  accept=".yaml,.yml,.json,.md,.txt,.openapi"
                  disabled={uploading}
                  onChange={(event) => {
                    void uploadFiles(event.target.files);
                    event.target.value = "";
                  }}
                  className="sr-only"
                />
              </label>
            ) : null}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">Kind</span>
              <select
                value={draft.kind}
                onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value as ToolContextKind }))}
                className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
              >
                {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">Title</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
                placeholder="API documentation, OpenAPI spec, implementation note"
                className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
              />
            </label>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">Source</span>
              <input
                value={draft.source}
                onChange={(event) => setDraft((value) => ({ ...value, source: event.target.value }))}
                placeholder="docs URL, file name, creation id"
                className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">MIME type</span>
              <input
                value={draft.mimeType}
                onChange={(event) => setDraft((value) => ({ ...value, mimeType: event.target.value }))}
                placeholder="application/json"
                className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
              />
            </label>
          </div>
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Content</span>
            <textarea
              value={draft.content}
              onChange={(event) => setDraft((value) => ({ ...value, content: event.target.value }))}
              rows={6}
              placeholder="Paste docs, OpenAPI, cURL examples, usage notes, or QA examples."
              className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending || update.isPending}
              className="rounded bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
            >
              {editingId ? "Save context" : "Add context"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(undefined);
                setDraft(defaultDraft());
                setFormOpen(false);
              }}
              className="rounded border border-app-border px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
          {create.isError || update.isError ? (
            <p className="mt-2 text-[11px] text-app-danger">
              {create.error?.message ?? update.error?.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function sortContextItems(items: ToolContextRecord[]): ToolContextRecord[] {
  return [...items].sort((a, b) => {
    const updatedDelta = b.updatedAt.localeCompare(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return kindPriority(a.kind) - kindPriority(b.kind);
  });
}

function toggleExpanded(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function kindPriority(kind: ToolContextKind): number {
  return {
    openapi: 0,
    "api-docs": 1,
    "docs-url": 2,
    file: 3,
    documentation: 4,
    "qa-example": 5,
    note: 6,
  }[kind];
}

function defaultDraft(): {
  kind: ToolContextKind;
  title: string;
  content: string;
  source: string;
  mimeType: string;
} {
  return { kind: "documentation", title: "", content: "", source: "", mimeType: "" };
}
