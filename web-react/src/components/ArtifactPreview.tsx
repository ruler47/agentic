import { useImageLightbox, type LightboxImage } from "@/components/ImageLightbox";

type ArtifactLike = {
  id?: string;
  filename: string;
  url: string;
  mimeType?: string;
  kind?: string;
  sizeBytes?: number;
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
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-app-accent underline"
        >
          Download
        </a>
      </div>
    </article>
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
