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
  centeredOverlayRatio?: number;
  consentOverlayRatio?: number;
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
  const hasConsentOverlay =
    stats.consentOverlayRatio > 0.2 &&
    stats.dominantColorRatio < 0.9 &&
    stats.edgeActivityRatio < 0.07 &&
    stats.laplacianVariance < 3_000;
  if (stats.centeredOverlayRatio > 0.18 || hasConsentOverlay) {
    return {
      ok: false,
      reason:
        "Screenshot appears to be covered by a modal or consent dialog rather than showing clear page content.",
      width: png.width,
      height: png.height,
      dominantColorRatio: stats.dominantColorRatio,
      edgeActivityRatio: stats.edgeActivityRatio,
      laplacianVariance: stats.laplacianVariance,
      centeredOverlayRatio: stats.centeredOverlayRatio,
      consentOverlayRatio: stats.consentOverlayRatio,
    };
  }

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
      centeredOverlayRatio: stats.centeredOverlayRatio,
      consentOverlayRatio: stats.consentOverlayRatio,
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
      centeredOverlayRatio: stats.centeredOverlayRatio,
      consentOverlayRatio: stats.consentOverlayRatio,
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
      centeredOverlayRatio: stats.centeredOverlayRatio,
      consentOverlayRatio: stats.consentOverlayRatio,
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
    centeredOverlayRatio: stats.centeredOverlayRatio,
    consentOverlayRatio: stats.consentOverlayRatio,
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
  let centeredOverlayBrightSamples = 0;
  let centeredOverlayMinX = png.width;
  let centeredOverlayMinY = png.height;
  let centeredOverlayMaxX = 0;
  let centeredOverlayMaxY = 0;

  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const current = pixelAt(png, x, y);
      const lum = luminance(current);
      const bucket = `${current.r >> 4},${current.g >> 4},${current.b >> 4},${current.a >> 6}`;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      samples += 1;

      if (isCenteredModalCandidatePixel(current, lum, x, y, png.width, png.height)) {
        centeredOverlayBrightSamples += 1;
        centeredOverlayMinX = Math.min(centeredOverlayMinX, x);
        centeredOverlayMinY = Math.min(centeredOverlayMinY, y);
        centeredOverlayMaxX = Math.max(centeredOverlayMaxX, x);
        centeredOverlayMaxY = Math.max(centeredOverlayMaxY, y);
      }

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
        const cLum = lum;
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
  const centeredOverlayRatio = estimateCenteredOverlayRatio({
    width: png.width,
    height: png.height,
    step,
    brightSamples: centeredOverlayBrightSamples,
    minX: centeredOverlayMinX,
    minY: centeredOverlayMinY,
    maxX: centeredOverlayMaxX,
    maxY: centeredOverlayMaxY,
  });
  const consentOverlayRatio = estimateConsentOverlayRatio(png, step);
  return {
    dominantColorRatio: samples ? dominant / samples : 1,
    edgeActivityRatio: edgeComparisons ? edges / edgeComparisons : 0,
    uniqueColorBuckets: buckets.size,
    laplacianVariance: Math.max(0, lapVar),
    centeredOverlayRatio,
    consentOverlayRatio,
  };
}

function estimateConsentOverlayRatio(png: PNG, step: number): number {
  const widthSteps = [0.34, 0.42, 0.5];
  const heightSteps = [0.26, 0.34, 0.42];
  const xSteps = [0.0, 0.01, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25];
  const ySteps = [0.28, 0.34, 0.42, 0.5, 0.56, 0.62];
  let best = 0;

  for (const wRatio of widthSteps) {
    for (const hRatio of heightSteps) {
      const boxWidth = Math.round(png.width * wRatio);
      const boxHeight = Math.round(png.height * hRatio);
      if (boxWidth < 220 || boxHeight < 140) continue;
      for (const xRatio of xSteps) {
        for (const yRatio of ySteps) {
          const x0 = Math.round(png.width * xRatio);
          const y0 = Math.round(png.height * yRatio);
          if (x0 + boxWidth > png.width || y0 + boxHeight > png.height) continue;
          const score = scoreConsentOverlayWindow(png, x0, y0, boxWidth, boxHeight, step);
          if (score > best) best = score;
        }
      }
    }
  }

  return best;
}

function scoreConsentOverlayWindow(
  png: PNG,
  x0: number,
  y0: number,
  boxWidth: number,
  boxHeight: number,
  step: number,
): number {
  let samples = 0;
  let bright = 0;
  let dark = 0;
  let buttonLike = 0;
  let edgeSamples = 0;
  let edgeLike = 0;

  for (let y = y0; y < y0 + boxHeight; y += step) {
    for (let x = x0; x < x0 + boxWidth; x += step) {
      const pixel = pixelAt(png, x, y);
      const lum = luminance(pixel);
      samples += 1;
      if (lum > 218 && colorSpread(pixel) < 38) bright += 1;
      if (lum < 95) dark += 1;
      if (isButtonLikePixel(pixel, lum)) buttonLike += 1;
      const nearEdge = x - x0 < step * 3 || x0 + boxWidth - x < step * 3 || y - y0 < step * 3 || y0 + boxHeight - y < step * 3;
      if (nearEdge) {
        edgeSamples += 1;
        if (lum > 220 && colorSpread(pixel) < 42) edgeLike += 1;
      }
    }
  }

  if (samples === 0 || edgeSamples === 0) return 0;
  const brightRatio = bright / samples;
  const darkRatio = dark / samples;
  const buttonRatio = buttonLike / samples;
  const edgeRatio = edgeLike / edgeSamples;
  const boxAreaRatio = (boxWidth * boxHeight) / (png.width * png.height);
  const leftOrLower = x0 < png.width * 0.32 || y0 > png.height * 0.34;
  const plausiblePanel =
    leftOrLower &&
    brightRatio > 0.55 &&
    edgeRatio > 0.52 &&
    darkRatio > 0.006 &&
    darkRatio < 0.22 &&
    buttonRatio > 0.004 &&
    boxAreaRatio > 0.08 &&
    boxAreaRatio < 0.28;

  return plausiblePanel ? boxAreaRatio * Math.min(1, brightRatio + buttonRatio * 5 + darkRatio) : 0;
}

function colorSpread(pixel: { r: number; g: number; b: number }): number {
  return Math.max(pixel.r, pixel.g, pixel.b) - Math.min(pixel.r, pixel.g, pixel.b);
}

function isButtonLikePixel(pixel: { r: number; g: number; b: number }, lum: number): boolean {
  if (lum < 45) return true;
  const blueTint = pixel.b - pixel.r > 18 && pixel.b - pixel.g > 8 && lum > 160;
  return blueTint;
}

function isCenteredModalCandidatePixel(
  pixel: { r: number; g: number; b: number; a: number },
  lum: number,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (x < width * 0.18 || x > width * 0.82 || y < height * 0.08 || y > height * 0.82) return false;
  const max = Math.max(pixel.r, pixel.g, pixel.b);
  const min = Math.min(pixel.r, pixel.g, pixel.b);
  return pixel.a > 230 && lum > 210 && max - min < 45;
}

function estimateCenteredOverlayRatio(input: {
  width: number;
  height: number;
  step: number;
  brightSamples: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): number {
  if (input.brightSamples < 40 || input.minX > input.maxX || input.minY > input.maxY) return 0;
  const boxWidthRatio = (input.maxX - input.minX + input.step) / input.width;
  const boxHeightRatio = (input.maxY - input.minY + input.step) / input.height;
  const centerX = (input.minX + input.maxX) / 2 / input.width;
  const centerY = (input.minY + input.maxY) / 2 / input.height;
  const centered = Math.abs(centerX - 0.5) < 0.2 && Math.abs(centerY - 0.45) < 0.28;
  const modalSized =
    boxWidthRatio >= 0.2 && boxWidthRatio <= 0.68 &&
    boxHeightRatio >= 0.12 && boxHeightRatio <= 0.68;
  if (!centered || !modalSized) return 0;

  const boxAreaSamples = Math.max(
    1,
    Math.ceil((input.maxX - input.minX + input.step) / input.step) *
      Math.ceil((input.maxY - input.minY + input.step) / input.step),
  );
  const fillRatio = input.brightSamples / boxAreaSamples;
  if (fillRatio < 0.45) return 0;
  return boxWidthRatio * boxHeightRatio * fillRatio;
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
