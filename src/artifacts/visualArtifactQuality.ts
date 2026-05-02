import { PNG } from "pngjs";
import { ArtifactCreateInput } from "../types.js";

export type VisualArtifactQualityReport = {
  ok: boolean;
  reason: string;
  width?: number;
  height?: number;
  dominantColorRatio?: number;
  edgeActivityRatio?: number;
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
    };
  }

  return {
    ok: true,
    reason: "PNG screenshot has enough visual variation to be treated as potentially useful evidence.",
    width: png.width,
    height: png.height,
    dominantColorRatio: stats.dominantColorRatio,
    edgeActivityRatio: stats.edgeActivityRatio,
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
    }
  }

  const dominant = Math.max(...buckets.values());
  return {
    dominantColorRatio: samples ? dominant / samples : 1,
    edgeActivityRatio: edgeComparisons ? edges / edgeComparisons : 0,
    uniqueColorBuckets: buckets.size,
  };
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
