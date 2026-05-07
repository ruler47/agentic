import { useEffect, useMemo, useState } from "react";

export type LightboxImage = {
  url: string;
  title?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  initialIndex: number;
  onClose: () => void;
};

export function ImageLightbox({ images, initialIndex, onClose }: ImageLightboxProps) {
  const safeImages = images.filter((image) => image.url);
  const [index, setIndex] = useState(() => clampIndex(initialIndex, safeImages.length));
  const [zoom, setZoom] = useState(1);
  const current = safeImages[index];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") setIndex((value) => clampIndex(value - 1, safeImages.length));
      if (event.key === "ArrowRight") setIndex((value) => clampIndex(value + 1, safeImages.length));
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(3, value + 0.25));
      if (event.key === "-") setZoom((value) => Math.max(0.5, value - 0.25));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, safeImages.length]);

  const canNavigate = safeImages.length > 1;

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-app-border bg-app-surface shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-app-border px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{current.title ?? "Image"}</p>
            <p className="font-mono text-[11px] text-app-text-muted">
              {index + 1} / {safeImages.length} · {Math.round(zoom * 100)}%
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
            >
              -
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
            >
              100%
            </button>
            <button
              type="button"
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
              className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-xs"
            >
              +
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-app-accent px-3 py-1 text-xs font-semibold text-app-bg"
            >
              Close
            </button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-4">
          {canNavigate ? (
            <button
              type="button"
              onClick={() => setIndex((value) => clampIndex(value - 1, safeImages.length))}
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-app-border bg-app-surface/90 px-3 py-2 text-lg"
              aria-label="Previous image"
            >
              ‹
            </button>
          ) : null}
          <img
            src={current.url}
            alt={current.title ?? "Preview"}
            className="max-h-[72vh] max-w-full rounded-md object-contain transition-transform"
            style={{ transform: `scale(${zoom})` }}
          />
          {canNavigate ? (
            <button
              type="button"
              onClick={() => setIndex((value) => clampIndex(value + 1, safeImages.length))}
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-app-border bg-app-surface/90 px-3 py-2 text-lg"
              aria-label="Next image"
            >
              ›
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function useImageLightbox(images: LightboxImage[]) {
  const normalized = useMemo(() => images.filter((image) => image.url), [images]);
  const [index, setIndex] = useState<number | undefined>();
  return {
    images: normalized,
    openAt: setIndex,
    close: () => setIndex(undefined),
    lightbox:
      index === undefined ? null : (
        <ImageLightbox images={normalized} initialIndex={index} onClose={() => setIndex(undefined)} />
      ),
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}
