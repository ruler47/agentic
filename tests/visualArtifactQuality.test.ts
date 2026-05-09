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

test("semantic artifact QA rejects visually valid 404 browser proof", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "doctoralia-404.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.doctoralia.es/%60.",
    },
    task: "Find allergy and immunology specialists in Spain or the Schengen area.",
    browser: {
      finalUrl: "https://www.doctoralia.es/%60",
      title: "404 Esta pagina no existe",
      extractedText: [
        {
          label: "page",
          text: "Doctoralia 404 Esta pagina no existe. No pudimos encontrar esta pagina. Encuentra al especialista que necesitas.",
        },
      ],
    },
    toolContent: "Final URL: https://www.doctoralia.es/%60",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "blocked_or_loader");
  assert.ok(report.blockerSignals.some((signal) => signal.includes("404")));
});

test("semantic artifact QA rejects utility pages that do not match the task", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "google-translate-proof.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://translate.google.com/.",
    },
    task: "Find the best laptop under 2000 USD that can be bought now.",
    browser: {
      finalUrl: "https://translate.google.com/",
      title: "Google Translate",
      extractedText: [{ label: "page", text: "Google Translate Detect language English Spanish" }],
    },
    toolContent: "Final URL: https://translate.google.com/",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "semantic_mismatch");
  assert.match(report.reason, /translation utility/i);
  assert.deepEqual(report.expectedEvidenceTypes, ["product_purchase"]);
  assert.deepEqual(report.observedEvidenceTypes, ["translation_utility"]);
});

test("semantic artifact QA rejects market research pages as laptop purchase proof", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "market-research-proof.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from a market research report.",
    },
    task: "дай мне абсолютно лучший лептоп до 2000$, что я могу сейчас купить",
    browser: {
      finalUrl: "https://www.bonafideresearch.com/product/laptop-market",
      title: "Laptop market research report",
      extractedText: [{ label: "page", text: "Bonafide Research laptop market size forecast report" }],
    },
    toolContent: "Final URL: https://www.bonafideresearch.com/product/laptop-market",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "semantic_mismatch");
  assert.match(report.reason, /market-research/i);
  assert.ok(report.expectedEvidenceTypes.includes("product_purchase"));
  assert.ok(report.observedEvidenceTypes.includes("market_research_report"));
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
