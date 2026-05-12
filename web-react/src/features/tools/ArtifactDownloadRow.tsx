import { useEffect, useMemo, useState } from "react";

import type { ManualRunArtifact } from "./artifactSniff";

/**
 * Shared download row used by both the Tools-page Manual Run result
 * panel (Slice H) and the Trace-Lab Inspector (Phase G follow-up).
 * Renders a single artifact as a one-line card with filename, MIME,
 * size, optional description, and a Download button.
 *
 * Phase 22 Slice D — when the artifact is a previewable type
 * (image, SVG, HTML, PDF) a "Preview" toggle expands an inline
 * viewer so the operator can SEE what the tool produced without
 * downloading + opening a separate viewer. Without this the
 * 3 507-byte screenshot from a failed QA run looks like a generic
 * "tiny PNG → tool is broken" until you actually open it and
 * realize it's a Twitch loading-state screenshot — the bug is
 * "wait longer", not "stealth plugin missing".
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

  const previewKind = useMemo(() => detectPreviewKind(artifact), [artifact]);
  const [showPreview, setShowPreview] = useState(false);

  return (
    <li className="flex flex-col gap-1 rounded border border-app-border bg-app-surface-2 px-2 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px]">{artifact.filename}</span>
        <span className="text-[10px] text-app-text-muted">
          {artifact.mimeType}
          {sizeHint !== undefined ? ` · ${formatBytes(sizeHint)}` : ""}
        </span>
        {artifact.description ? (
          <span className="text-[10px] text-app-text-muted">{artifact.description}</span>
        ) : null}
        {href && previewKind ? (
          <button
            type="button"
            onClick={() => setShowPreview((value) => !value)}
            className="ml-auto rounded border border-app-border px-2 py-0.5 text-[10px] hover:border-app-accent/40"
          >
            {showPreview ? "Hide preview" : "Preview"}
          </button>
        ) : null}
        {href ? (
          <a
            href={href}
            download={artifact.filename}
            className={`${previewKind ? "" : "ml-auto "}rounded bg-app-accent px-2 py-0.5 text-[10px] font-semibold text-app-bg hover:opacity-90`}
          >
            Download
          </a>
        ) : (
          <span className="ml-auto text-[10px] text-app-text-muted">no content</span>
        )}
      </div>
      {href && previewKind && showPreview ? (
        <div className="mt-1 overflow-hidden rounded border border-app-border bg-app-bg">
          <ArtifactPreview kind={previewKind} href={href} mimeType={artifact.mimeType} filename={artifact.filename} />
        </div>
      ) : null}
    </li>
  );
}

type PreviewKind = "image" | "svg" | "html" | "pdf";

function detectPreviewKind(artifact: ManualRunArtifact): PreviewKind | undefined {
  const mime = artifact.mimeType.toLowerCase();
  if (mime.startsWith("image/svg") || mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html") return "html";
  if (mime === "application/pdf") return "pdf";
  return undefined;
}

function ArtifactPreview({
  kind,
  href,
  mimeType,
  filename,
}: {
  kind: PreviewKind;
  href: string;
  mimeType: string;
  filename: string;
}) {
  if (kind === "image" || kind === "svg") {
    // SVG works through the same <img> tag when served via the
    // data:image/svg+xml href — no need for an iframe.
    return (
      <img
        src={href}
        alt={filename}
        className="block max-h-[420px] w-full object-contain"
        loading="lazy"
      />
    );
  }
  if (kind === "pdf") {
    return (
      <object
        data={href}
        type={mimeType}
        className="block h-[420px] w-full"
        aria-label={filename}
      >
        <p className="p-3 text-[11px] text-app-text-muted">
          PDF preview not supported in this browser — use the Download button.
        </p>
      </object>
    );
  }
  // kind === "html"
  return (
    <iframe
      src={href}
      title={filename}
      sandbox="allow-same-origin"
      className="block h-[420px] w-full bg-app-bg"
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
