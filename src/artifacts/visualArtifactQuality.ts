import { PNG } from "pngjs";
import { ArtifactCreateInput } from "../types.js";

export type VisualArtifactQualityReport = {
  ok: boolean;
  reason: string;
  width?: number;
  height?: number;
  dominantColorRatio?: number;
  edgeActivityRatio?: number;
  /**
   * Phase 12 follow-up: Laplacian variance proxy. Sharp pages have a
   * heavy distribution of intensity changes (text edges, button borders).
   * Blurred / out-of-focus screenshots have a smooth intensity field and
   * therefore a low Laplacian variance. Any value below ~25 on the
   * 0..2550 scale is treated as "not readable" — a thin signal but
   * dramatically better than the previous "near-empty" check which
   * treated blurry screenshots as fine because they had color diversity.
   */
  laplacianVariance?: number;
};

export function inspectScreenshotArtifact(input: ArtifactCreateInput): VisualArtifactQualityReport {
  if (input.mimeType !== "image/png") {
    return { ok: true, reason: "Visual QA only applies to PNG screenshots." };
  }

  const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  let png: PNG;
  try {
    png = PNG.sync.read(buffer);
  } catch (error) {
    return {
      ok: false,
      reason: `PNG screenshot could not be decoded for visual QA: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  const stats = samplePngStats(png);
  if (stats.dominantColorRatio > 0.985 && stats.edgeActivityRatio < 0.01) {
    return {
      ok: false,
      reason:
        "Screenshot is visually near-empty: one color dominates almost the entire image and there is almost no edge/content activity.",
      width: png.width,
      height: png.height,
      dominantColorRatio: stats.dominantColorRatio,
      edgeActivityRatio: stats.edgeActivityRatio,
      laplacianVariance: stats.laplacianVariance,
    };
  }

  if (stats.dominantColorRatio > 0.965 && stats.edgeActivityRatio < 0.018 && stats.uniqueColorBuckets < 48) {
    return {
      ok: false,
      reason:
        "Screenshot looks like a mostly blank loader/blocker rather than useful page evidence: low color diversity and low content activity.",
      width: png.width,
      height: png.height,
      dominantColorRatio: stats.dominantColorRatio,
      edgeActivityRatio: stats.edgeActivityRatio,
      laplacianVariance: stats.laplacianVariance,
    };
  }

  // Phase 12 follow-up: blur detection. A sharp screenshot of a real
  // webpage has plenty of high-frequency intensity transitions from
  // text and UI chrome. Below ~25 on the 0..2550 scale the image is
  // either out of focus or covered by a glassy overlay (cookie banner
  // backdrop) — neither is useful evidence. The threshold is
  // intentionally conservative; pure photos of nature are usually
  // 60-200, even bare loading pages are 30-60.
  if (stats.laplacianVariance < 25 && stats.uniqueColorBuckets >= 48) {
    return {
      ok: false,
      reason:
        `Screenshot is too blurry / out-of-focus to be useful evidence (Laplacian variance ${stats.laplacianVariance.toFixed(1)} < 25). Common causes: cookie-banner overlay still on screen, page captured before content rendered, or a privacy blur filter on top.`,
      width: png.width,
      height: png.height,
      dominantColorRatio: stats.dominantColorRatio,
      edgeActivityRatio: stats.edgeActivityRatio,
      laplacianVariance: stats.laplacianVariance,
    };
  }

  return {
    ok: true,
    reason: "PNG screenshot has enough visual variation to be treated as potentially useful evidence.",
    width: png.width,
    height: png.height,
    dominantColorRatio: stats.dominantColorRatio,
    edgeActivityRatio: stats.edgeActivityRatio,
    laplacianVariance: stats.laplacianVariance,
  };
}

function samplePngStats(png: PNG) {
  const maxSamples = 80_000;
  const pixelCount = png.width * png.height;
  const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / maxSamples)));
  const buckets = new Map<string, number>();
  let samples = 0;
  let edgeComparisons = 0;
  let edges = 0;

  // Phase 12 follow-up: accumulate Laplacian-style second-difference
  // values for blur detection. A sharp page has many sharp transitions;
  // a blurred / overlaid screenshot has smooth intensity. We use a
  // 3-tap discrete Laplacian on the grayscale luminance and track its
  // variance on the sampled grid.
  let laplacianSum = 0;
  let laplacianSumSq = 0;
  let laplacianN = 0;

  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const current = pixelAt(png, x, y);
      const bucket = `${current.r >> 4},${current.g >> 4},${current.b >> 4},${current.a >> 6}`;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      samples += 1;

      if (x + step < png.width) {
        edgeComparisons += 1;
        if (colorDistance(current, pixelAt(png, x + step, y)) > 42) edges += 1;
      }
      if (y + step < png.height) {
        edgeComparisons += 1;
        if (colorDistance(current, pixelAt(png, x, y + step)) > 42) edges += 1;
      }

      // 3-tap Laplacian on luminance: L(x,y) = -4*c + l + r + u + d.
      // Skip border samples where any neighbor is out of range.
      const lx = x - step;
      const rx = x + step;
      const uy = y - step;
      const dy = y + step;
      if (lx >= 0 && rx < png.width && uy >= 0 && dy < png.height) {
        const cLum = luminance(current);
        const lap =
          luminance(pixelAt(png, lx, y)) +
          luminance(pixelAt(png, rx, y)) +
          luminance(pixelAt(png, x, uy)) +
          luminance(pixelAt(png, x, dy)) -
          4 * cLum;
        laplacianSum += lap;
        laplacianSumSq += lap * lap;
        laplacianN += 1;
      }
    }
  }

  const dominant = Math.max(...buckets.values());
  const lapMean = laplacianN > 0 ? laplacianSum / laplacianN : 0;
  const lapVar = laplacianN > 0 ? laplacianSumSq / laplacianN - lapMean * lapMean : 0;
  return {
    dominantColorRatio: samples ? dominant / samples : 1,
    edgeActivityRatio: edgeComparisons ? edges / edgeComparisons : 0,
    uniqueColorBuckets: buckets.size,
    laplacianVariance: Math.max(0, lapVar),
  };
}

function luminance(p: { r: number; g: number; b: number }) {
  // Rec. 601 luma; we don't need perceptual accuracy, just a single
  // intensity channel for the Laplacian.
  return 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
}

function pixelAt(png: PNG, x: number, y: number) {
  const offset = (png.width * y + x) << 2;
  return {
    r: png.data[offset] ?? 0,
    g: png.data[offset + 1] ?? 0,
    b: png.data[offset + 2] ?? 0,
    a: png.data[offset + 3] ?? 255,
  };
}

function colorDistance(
  left: { r: number; g: number; b: number; a: number },
  right: { r: number; g: number; b: number; a: number },
) {
  return Math.abs(left.r - right.r) + Math.abs(left.g - right.g) + Math.abs(left.b - right.b) + Math.abs(left.a - right.a);
}
