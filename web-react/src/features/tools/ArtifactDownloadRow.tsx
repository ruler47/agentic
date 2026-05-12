import { useEffect, useMemo } from "react";

import type { ManualRunArtifact } from "./artifactSniff";

/**
 * Shared download row used by both the Tools-page Manual Run result
 * panel (Slice H) and the Trace-Lab Inspector (Phase G follow-up).
 * Renders a single artifact as a one-line card with filename, MIME,
 * size, optional description, and a Download button.
 */
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

  useEffect(() => {
    return () => {
      if (href && href.startsWith("blob:")) URL.revokeObjectURL(href);
    };
  }, [href]);

  const sizeHint = useMemo(() => {
    if (artifact.contentBase64) {
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
