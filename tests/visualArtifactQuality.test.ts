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

test("visual artifact QA rejects centered cookie consent modal overlays", () => {
  const png = new PNG({ width: 500, height: 320 });
  fill(png, 155, 160, 165);
  for (let y = 24; y < 290; y += 26) {
    drawRect(png, 24, y, 410, 10, 25, 35, 45);
    drawRect(png, 24, y + 13, 300, 6, 90, 100, 110);
  }
  drawRect(png, 155, 58, 190, 190, 248, 248, 248);
  drawRect(png, 185, 90, 130, 10, 20, 30, 40);
  drawRect(png, 185, 120, 120, 7, 70, 80, 90);
  drawRect(png, 190, 220, 60, 18, 20, 105, 220);
  drawRect(png, 260, 220, 55, 18, 20, 105, 220);

  const report = inspectScreenshotArtifact({
    filename: "cookie-modal.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A page screenshot covered by a centered consent modal.",
  });

  assert.equal(report.ok, false);
  assert.match(report.reason, /modal|consent/i);
  assert.ok((report.centeredOverlayRatio ?? 0) > 0.18);
});

test("visual artifact QA rejects lower-left cookie consent panels over blurred content", () => {
  const png = new PNG({ width: 1280, height: 720 });
  fill(png, 248, 250, 252);
  drawRect(png, 0, 0, 1280, 64, 255, 255, 255);
  drawRect(png, 24, 26, 190, 16, 20, 24, 28);
  for (let y = 96; y < 680; y += 38) {
    drawRect(png, 24, y, 680, 18, 216, 220, 224);
    drawRect(png, 24, y + 24, 560, 12, 230, 233, 236);
  }

  drawRect(png, 16, 314, 607, 309, 255, 255, 255);
  drawRect(png, 40, 344, 270, 22, 14, 18, 22);
  for (let y = 392; y < 500; y += 22) {
    drawRect(png, 40, y, 520, 10, 88, 92, 102);
  }
  drawRect(png, 40, 520, 178, 40, 0, 0, 0);
  drawRect(png, 230, 520, 178, 40, 255, 255, 255);
  drawRect(png, 420, 520, 178, 40, 236, 248, 255);
  drawRect(png, 270, 536, 90, 10, 20, 24, 28);
  drawRect(png, 468, 536, 80, 10, 20, 24, 28);

  const report = inspectScreenshotArtifact({
    filename: "cookie-panel.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A page screenshot covered by a lower-left consent panel.",
  });

  assert.equal(report.ok, false);
  assert.match(report.reason, /modal|consent/i);
  assert.ok((report.consentOverlayRatio ?? 0) > 0.12);
});

test("visual artifact QA accepts normal lower-left page content with a CTA button", () => {
  const png = new PNG({ width: 1280, height: 720 });
  fill(png, 255, 255, 255);
  drawRect(png, 0, 0, 1280, 64, 255, 255, 255);
  drawRect(png, 24, 24, 190, 18, 18, 22, 26);
  for (let x = 360; x < 850; x += 120) {
    drawRect(png, x, 28, 72, 10, 92, 96, 108);
  }
  for (let y = 205; y < 265; y += 36) {
    drawRect(png, 24, y, 720, 20, 12, 16, 20);
  }
  for (let y = 292; y < 430; y += 26) {
    drawRect(png, 24, y, 760, 12, 108, 112, 124);
  }
  for (let y = 468; y < 555; y += 18) {
    for (let x = 58; x < 760; x += 82) {
      drawRect(png, x, y, 52, 7, 72, 76, 88);
      drawRect(png, x + 58, y + 2, 18, 5, 120, 124, 136);
    }
  }
  for (let y = 640; y < 704; y += 12) {
    drawRect(png, 24, y, 760, 5, 92, 96, 108);
  }
  drawRect(png, 24, 586, 208, 42, 0, 0, 0);
  drawRect(png, 88, 602, 86, 10, 255, 255, 255);

  const report = inspectScreenshotArtifact({
    filename: "normal-page-content.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A normal page section with lower-left content and a call-to-action button.",
  });

  assert.equal(report.ok, true);
  assert.ok((report.consentOverlayRatio ?? 0) > 0.12);
  assert.ok((report.edgeActivityRatio ?? 0) >= 0.07 || (report.laplacianVariance ?? 0) >= 6_500);
});

test("visual artifact QA accepts sparse white service-listing pages with real controls", () => {
  const png = new PNG({ width: 1280, height: 720 });
  fill(png, 255, 255, 255);
  drawRect(png, 16, 218, 390, 24, 20, 24, 28);
  drawRect(png, 16, 254, 260, 11, 112, 116, 124);
  drawRect(png, 16, 280, 90, 10, 100, 105, 112);
  drawRect(png, 16, 304, 120, 10, 100, 105, 112);
  drawRect(png, 16, 414, 145, 10, 48, 52, 58);
  drawRect(png, 16, 476, 38, 31, 120, 160, 190);
  drawRect(png, 58, 476, 38, 31, 100, 140, 170);
  drawRect(png, 100, 476, 38, 31, 238, 238, 238);
  drawRect(png, 16, 348, 118, 22, 54, 58, 64);
  drawRect(png, 474, 342, 340, 38, 236, 236, 236);
  drawRect(png, 690, 478, 55, 12, 46, 50, 56);
  drawRect(png, 754, 472, 45, 31, 20, 150, 190);
  drawRect(png, 15, 557, 800, 1, 232, 232, 232);
  drawRect(png, 16, 580, 155, 13, 48, 52, 58);
  drawRect(png, 16, 616, 180, 10, 90, 94, 102);
  drawRect(png, 16, 642, 150, 10, 90, 94, 102);
  drawRect(png, 16, 666, 130, 10, 90, 94, 102);
  drawRect(png, 58, 650, 38, 31, 88, 128, 158);
  drawRect(png, 100, 650, 38, 31, 78, 118, 148);
  drawRect(png, 690, 681, 55, 12, 46, 50, 56);
  drawRect(png, 754, 672, 45, 31, 20, 150, 190);

  const report = inspectScreenshotArtifact({
    filename: "service-listing.png",
    mimeType: "image/png",
    content: PNG.sync.write(png),
    description: "A sparse white service listing page with selectable appointment controls.",
  });

  assert.equal(report.ok, true);
  assert.ok((report.consentOverlayRatio ?? 0) > 0.12);
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

test("semantic artifact QA treats browser challenge pages as hard blockers even when source text matches", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "www-pcmag-com.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.pcmag.com/picks/the-best-laptops-for-programmers.",
    },
    task: "Compare current laptops and provide proof.",
    browser: {
      finalUrl: "https://www.pcmag.com/picks/the-best-laptops-for-programmers",
      title: "Just a moment...",
      extractedText: [{ label: "focusText", text: "2026 PCMag" }],
    },
    expectedSignals: ["2026", "PCMag"],
    toolContent: "Screenshot captured. title: Just a moment...",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "blocked_or_loader");
});

test("semantic artifact QA rejects provider interstitial pages before URL or claim matching", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "asus_rog_strix_g16_proof_v2.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS.",
    },
    task: "Подбери ноутбук для локальных LLM и игр до 2500 долларов.",
    browser: {
      finalUrl: "https://www.amazon.com/ASUS-2025-ROG-Strix-G16/dp/B0F8JZB2ZS",
      title: "Amazon.com",
      extractedText: [
        {
          label: "visible-page",
          text: "Click the button below to continue shopping\nContinue shopping\nConditions of Use Privacy Policy",
        },
      ],
    },
    expectedSignals: ["ASUS ROG Strix G16"],
    toolContent: "Screenshot captured.",
  });

  assert.equal(report.ok, false);
  assert.equal(report.decision, "blocked_or_loader");
  assert.ok(report.blockerSignals.includes("continue interstitial"));
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

test("semantic artifact QA uses explicit evidence signals for focused proof screenshots", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "btc-price.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://example.test/btc.",
    },
    task: "Какая сейчас цена биткоина? Дай скриншот-пруф.",
    browser: {
      finalUrl: "https://example.test/btc",
      title: "Bitcoin price",
      extractedText: [{ label: "focusText", text: "$78,196.83" }],
    },
    expectedSignals: ["$78,196.83"],
    toolContent: "Screenshot captured.",
  });

  assert.equal(report.ok, true);
  assert.equal(report.decision, "usable");
  assert.ok(report.matchedSignals.includes("$78,196.83"));
});

test("semantic artifact QA matches multi-word claim signals across page title, url, and content", () => {
  const png = contentHeavyPng();

  const report = inspectBrowserScreenshotEvidence({
    artifact: {
      filename: "rog-asus-com.png",
      mimeType: "image/png",
      content: PNG.sync.write(png),
      description: "Browser screenshot captured from https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/.",
    },
    task: "Подбери актуальный ноутбук для LLM, игр, батареи и веса.",
    browser: {
      finalUrl: "https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/",
      title: "ROG Zephyrus G14 (2026) GU405 | ROG - Republic of Gamers",
      extractedText: [{ label: "focusText", text: "NVIDIA GeForce RTX 5080 Laptop GPU" }],
    },
    expectedSignals: ["ASUS ROG Zephyrus G14 2026", "NVIDIA RTX 50"],
    toolContent: "Screenshot captured: ROG Zephyrus G14 2026 with RTX 5080.",
  });

  assert.equal(report.ok, true);
  assert.equal(report.decision, "usable");
  assert.ok(report.matchedSignals.includes("asus rog zephyrus g14 2026"));
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
