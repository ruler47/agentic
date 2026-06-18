import { useImageLightbox, type LightboxImage } from "@/components/ImageLightbox";
import { GenericBadge } from "@/components/StatusBadge";
import { truncate } from "@/lib/format";
import type { ArtifactQualityMetadata } from "@/api/types";

type ArtifactLike = {
  id?: string;
  filename: string;
  url: string;
  mimeType?: string;
  kind?: string;
  sizeBytes?: number;
  contentPreview?: string;
  description?: string;
  quality?: ArtifactQualityMetadata;
};

type ArtifactGalleryProps = {
  artifacts: ArtifactLike[];
  compact?: boolean;
};

export function ArtifactGallery({ artifacts, compact = false }: ArtifactGalleryProps) {
  const images = artifacts.filter(isImageArtifact).map(toLightboxImage);
  const lightbox = useImageLightbox(images);

  if (artifacts.length === 0) return null;

  return (
    <>
      <ul className={compact ? "grid gap-2" : "grid gap-2 sm:grid-cols-2"}>
        {artifacts.map((artifact) => {
          const imageIndex = images.findIndex((image) => image.url === artifact.url);
          return (
            <li key={artifact.id ?? artifact.url ?? artifact.filename}>
              <ArtifactCard
                artifact={artifact}
                imageIndex={imageIndex >= 0 ? imageIndex : undefined}
                onOpenImage={(index) => lightbox.openAt(index)}
                compact={compact}
              />
            </li>
          );
        })}
      </ul>
      {lightbox.lightbox}
    </>
  );
}

export function ArtifactCard({
  artifact,
  imageIndex,
  onOpenImage,
  compact = false,
}: {
  artifact: ArtifactLike;
  imageIndex?: number;
  onOpenImage?: (index: number) => void;
  compact?: boolean;
}) {
  const isImage = isImageArtifact(artifact);
  const downloadUrl = artifactDownloadUrl(artifact.url);
  return (
    <article className="overflow-hidden rounded-md border border-app-border bg-app-surface-2 text-xs">
      {isImage ? (
        <button
          type="button"
          onClick={() => imageIndex !== undefined && onOpenImage?.(imageIndex)}
          className="block w-full bg-black/20"
          title="Open image preview"
        >
          <img
            src={artifact.url}
            alt={artifact.filename}
            className={compact ? "h-28 w-full object-cover" : "h-40 w-full object-cover"}
            loading="lazy"
          />
        </button>
      ) : null}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono">{artifact.filename}</span>
          {artifact.kind ? (
            <span className="shrink-0 text-[10px] text-app-text-muted">{artifact.kind}</span>
          ) : null}
        </div>
        <p className="mt-1 text-[11px] text-app-text-muted">
          {artifact.mimeType ?? "unknown"}
          {typeof artifact.sizeBytes === "number"
            ? ` · ${Math.max(0, Math.round(artifact.sizeBytes / 1024))} KB`
            : ""}
        </p>
        {!isImage && artifact.contentPreview ? (
          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-app-border bg-app-surface px-2 py-1 font-mono text-[10px]">
            {truncate(artifact.contentPreview, compact ? 320 : 800)}
          </pre>
        ) : null}
        {artifact.description ? (
          <p className="mt-2 text-[11px] text-app-text-muted">{truncate(artifact.description, 180)}</p>
        ) : null}
        <ArtifactQualityBadge quality={artifact.quality} />
        <div className="mt-2 flex flex-wrap gap-2">
          <a
            href={artifact.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
          >
            {isImage ? "Preview" : "Open"}
          </a>
          <a
            href={downloadUrl}
            download={artifact.filename}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px] hover:border-app-accent/40"
          >
            Download
          </a>
        </div>
      </div>
    </article>
  );
}

export function ArtifactQualityBadge({ quality }: { quality?: ArtifactQualityMetadata }) {
  if (!quality) return null;
  const checks = quality.checks ?? [];
  const tone =
    quality.status === "passed" ? "ok" : quality.status === "failed" ? "danger" : "warn";
  return (
    <details className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <summary className="flex cursor-pointer items-center gap-2">
        <GenericBadge tone={tone}>QA: {quality.status}</GenericBadge>
        <span className="text-app-text-muted">
          {checks.length} check{checks.length === 1 ? "" : "s"}
        </span>
      </summary>
      {checks.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {checks.map((check, index) => (
            <li key={`${check.name}-${index}`} className={check.ok ? "" : "text-app-danger"}>
              <strong>{check.ok ? "pass" : "fail"}</strong> · {check.name}
              {check.reason ? (
                <span className="text-app-text-muted"> - {truncate(check.reason, 140)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function isImageArtifact(artifact: Pick<ArtifactLike, "filename" | "mimeType" | "url">): boolean {
  const mime = artifact.mimeType?.toLowerCase() ?? "";
  const name = artifact.filename.toLowerCase();
  const url = artifact.url.toLowerCase();
  return (
    mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(name) ||
    /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(url)
  );
}

function toLightboxImage(artifact: ArtifactLike): LightboxImage {
  return {
    url: artifact.url,
    title: artifact.filename,
  };
}

export function artifactDownloadUrl(url: string): string {
  if (!url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}download=1`;
}
