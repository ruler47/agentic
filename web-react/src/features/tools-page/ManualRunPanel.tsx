import { useEffect, useMemo, useState } from "react";

import { useRunToolManually, type ManualToolRunResponse } from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import {
  collectArtifacts as collectArtifactsFromResult,
  type ManualRunArtifact as ManualRunArtifactType,
} from "@/features/tools/artifactSniff";
import type { ToolModuleMetadata } from "@/api/types";

import { buildSchemaExample, formatBytes, InputSchemaSummary } from "./toolsPageShared";

export function ManualRunPanel({ tool }: { tool: ToolModuleMetadata }) {
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

export function ManualRunResultDisplay({ response }: { response: ManualToolRunResponse }) {
  const { result, durationMs, tool, diagnostic } = response;
  // Phase 16 Slice H: scan BOTH `result.data` (where binary payloads
  // like screenshot.url's `imageBase64` live) AND `result.content`
  // (where text payloads like chart.svg's SVG markup live). Wrap
  // them in a synthetic object so the recursive walker treats the
  // content key as a hinting parent key for sniffing.
  const artifacts = useMemo(
    () =>
      collectArtifactsFromResult({
        content: result.content,
        data: result.data,
      }),
    [result.content, result.data],
  );
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
      {diagnostic ? <ManualRunDiagnosticPanel diagnostic={diagnostic} /> : null}
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

export function ManualRunDiagnosticPanel({
  diagnostic,
}: {
  diagnostic: NonNullable<ManualToolRunResponse["diagnostic"]>;
}) {
  return (
    <div className="mt-2 rounded-md border border-app-warning/40 bg-app-warning-soft/40 p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-app-warning">
          <GenericBadge tone="warn">runtime requirements</GenericBadge>
          Manual run could not start the package.
        </p>
        {diagnostic.missingSecretHandles.length > 0 ? (
          <a
            href="/settings"
            className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px] text-app-text hover:border-app-accent/40"
          >
            Manage secrets
          </a>
        ) : null}
      </div>
      <p className="mt-1 text-app-text-muted">{diagnostic.message}</p>
      {diagnostic.missingConfigurationKeys.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-app-text-muted">Missing configuration</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {diagnostic.missingConfigurationKeys.map((key) => (
              <li key={key} className="rounded bg-app-surface px-1.5 py-0.5 font-mono text-[10px]">
                {key}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diagnostic.missingSecretHandles.length > 0 ? (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-app-text-muted">Missing secret handles</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {diagnostic.missingSecretHandles.map((handle) => (
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
 * Phase 13 follow-up + Phase 16 Slice H: artifact-shaped payload
 * extracted from a manual tool-run response. The actual recursive
 * walk and MIME sniffing live in
 * `@/features/tools/artifactSniff` so they can be unit-tested
 * standalone — the type alias is kept here for the in-file UI
 * components.
 */
export type ManualRunArtifact = ManualRunArtifactType;

export function ArtifactDownloadRow({ artifact }: { artifact: ManualRunArtifact }) {
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
  const isImage = artifact.mimeType.toLowerCase().startsWith("image/");

  return (
    <li className="rounded border border-app-border bg-app-surface-2 p-2">
      {isImage && href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mb-2 block overflow-hidden rounded border border-app-border bg-black/20">
          <img src={href} alt={artifact.filename} className="max-h-40 w-full object-contain" />
        </a>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px]">{artifact.filename}</span>
        <span className="text-[10px] text-app-text-muted">
          {artifact.mimeType}
          {sizeHint !== undefined ? ` · ${formatBytes(sizeHint)}` : ""}
        </span>
        {artifact.description ? (
          <span className="text-[10px] text-app-text-muted">{artifact.description}</span>
        ) : null}
        {href ? (
          <span className="ml-auto flex gap-1">
            {isImage ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-app-border bg-app-surface px-2 py-0.5 text-[10px] hover:border-app-accent/40"
              >
                Preview
              </a>
            ) : null}
            <a
              href={href}
              download={artifact.filename}
              className="rounded bg-app-accent px-2 py-0.5 text-[10px] font-semibold text-app-bg hover:opacity-90"
            >
              Download
            </a>
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-app-text-muted">no content</span>
        )}
      </div>
    </li>
  );
}
