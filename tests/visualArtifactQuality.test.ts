import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { inspectScreenshotArtifact } from "../src/artifacts/visualArtifactQuality.js";
import { inspectBrowserScreenshotEvidence } from "../src/artifacts/semanticArtifactQuality.js";

test("visual artifact QA rejects near-empty screenshot loaders", () => {
  const png = new PNG({ width: 500, height: 320 });
  fill(png, 255, 255, 255);
  drawRect(png, 236, 146, 28, 28, 245, 40, 120);

  const report = inspectScreenshotArtifact({
    filename: "loader.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A mostly blank loader screenshot.",
  });

  assert.equal(report.ok, false);
  assert.match(report.reason, /blank|loader|empty/i);
});

test("visual artifact QA accepts screenshots with enough visible content", () => {
  const png = new PNG({ width: 500, height: 320 });
  fill(png, 250, 250, 250);
  for (let y = 24; y < 290; y += 26) {
    drawRect(png, 24, y, 410, 10, 25, 35, 45);
    drawRect(png, 24, y + 13, 300, 6, 90, 100, 110);
  }

  const report = inspectScreenshotArtifact({
    filename: "content.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A content-heavy screenshot.",
  });

  assert.equal(report.ok, true);
  assert.ok((report.edgeActivityRatio ?? 0) > 0);
});

test("semantic artifact QA rejects visually valid but blocked browser proof", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "proof-instagram.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.instagram.com/.",
    },
    task: "Find a real public proof screenshot for Instagram profile deadp47.",
    browser: {
      finalUrl: "https://www.instagram.com/",
      title: "Instagram",
      extractedText: [{ label: "page", text: "Instagram from Meta" }],
    },
    toolContent: "Executed browser commands and captured screenshot.",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "blocked_or_loader");
});

test("semantic artifact QA accepts visually valid relevant browser proof", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "deadp47-profile.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.instagram.com/deadp47/.",
    },
    task: "Find public proof for Instagram profile deadp47.",
    browser: {
      finalUrl: "https://www.instagram.com/deadp47/",
      title: "deadp47 • Instagram profile",
      extractedText: [{ label: "page", text: "deadp47 posts followers Instagram profile" }],
    },
    toolContent: "Final URL: https://www.instagram.com/deadp47/",
  });

  assert.equal(report.ok, true);
  assert.equal(report.decision, "usable");
  assert.ok(report.matchedSignals.includes("deadp47"));
});

test("semantic artifact QA rejects external action proof on provider business landing pages", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "external-action-pre-submit-proof-www-fresha-com-for-business-screenshot.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.fresha.com/for-business.",
    },
    task: "Prepare external action booking appointment proof before final submit.",
    browser: {
      finalUrl: "https://www.fresha.com/for-business",
      title: "Fresha | Top Salon Software | Salon Management Software",
      extractedText: [{ label: "page", text: "Top salon software and barber booking management software for businesses." }],
    },
    toolContent: "Final URL: https://www.fresha.com/for-business",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "semantic_mismatch");
});

test("semantic artifact QA rejects external action proof on unavailable provider pages", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "external-action-pre-submit-proof-booksy-screenshot.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://booksy.com/es-es/148702_memento.",
    },
    task: "Prepare external action booking appointment proof before final submit.",
    browser: {
      finalUrl: "https://booksy.com/es-es/148702_memento",
      title: "Booksy",
      extractedText: [
        {
          label: "page",
          text: "404 ¡Vaya! La página que buscas no está disponible. Regresa a nuestra página principal.",
        },
      ],
    },
    toolContent: "Final URL: https://booksy.com/es-es/148702_memento",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "semantic_mismatch");
});

function fill(png: PNG, r: number, g: number, b: number) {
  drawRect(png, 0, 0, png.width, png.height, r, g, b);
}

function contentHeavyPng() {
  const png = new PNG({ width: 500, height: 320 });
  fill(png, 250, 250, 250);
  for (let y = 24; y < 290; y += 26) {
    drawRect(png, 24, y, 410, 10, 25, 35, 45);
    drawRect(png, 24, y + 13, 300, 6, 90, 100, 110);
  }
  return png;
}

function drawRect(png: PNG, x: number, y: number, width: number, height: number, r: number, g: number, b: number) {
  for (let row = y; row < Math.min(png.height, y + height); row += 1) {
    for (let column = x; column < Math.min(png.width, x + width); column += 1) {
      const offset = (png.width * row + column) << 2;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  }
}
