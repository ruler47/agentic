import { describe, expect, test } from "vitest";
import { collectArtifacts, sniffStringForFile } from "./artifactSniff";

describe("sniffStringForFile", () => {
  test("PNG base64 magic prefix → image/png", () => {
    const out = sniffStringForFile("imageBase64", "iVBORw0KGgoAAAANSUhEUgAAAlgAAAJYCAYAAAC", "data");
    expect(out?.mimeType).toBe("image/png");
    expect(out?.filename).toMatch(/\.png$/);
    expect(out?.contentBase64).toBeDefined();
  });

  test("JPEG base64 magic prefix → image/jpeg", () => {
    const out = sniffStringForFile("photo", "/9j/4AAQSkZJRgABAQEASABIAAAA", undefined);
    expect(out?.mimeType).toBe("image/jpeg");
    expect(out?.filename).toMatch(/\.jpg$/);
  });

  test("PDF base64 magic prefix → application/pdf", () => {
    const out = sniffStringForFile("pdfBase64", "JVBERi0xLjQKJeLjz9MKMSAwIA", undefined);
    expect(out?.mimeType).toBe("application/pdf");
    expect(out?.filename).toMatch(/\.pdf$/);
  });

  test("ZIP base64 magic prefix → application/zip", () => {
    const out = sniffStringForFile("archive", "UEsDBBQAAAAIAJqHAAAA", undefined);
    expect(out?.mimeType).toBe("application/zip");
  });

  test("SVG markup → image/svg+xml", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';
    const out = sniffStringForFile("content", svg, undefined);
    expect(out?.mimeType).toBe("image/svg+xml");
    expect(out?.content).toBe(svg);
  });

  test("HTML markup → text/html", () => {
    const html = "<!DOCTYPE html><html><body></body></html>";
    const out = sniffStringForFile("content", html, undefined);
    expect(out?.mimeType).toBe("text/html");
  });

  test("plain prose is NOT a file (no hint, no magic)", () => {
    const out = sniffStringForFile("summary", "The quick brown fox jumps over the lazy dog. Multiple sentences follow.", undefined);
    expect(out).toBeUndefined();
  });

  test("string too short to be a file", () => {
    const out = sniffStringForFile("imageBase64", "abc", undefined);
    expect(out).toBeUndefined();
  });

  test("hinted key with unrecognised magic falls back to octet-stream", () => {
    // 32 chars of valid base64 alphabet, no known prefix.
    const out = sniffStringForFile("fileBytesBase64", "QWxwaGFCcmF2b0NoYXJsaWVEZWx0YQ==", undefined);
    expect(out?.mimeType).toBe("application/octet-stream");
    expect(out?.filename).toMatch(/\.bin$/);
  });

  test("generic key 'content' uses parent name for filename", () => {
    const out = sniffStringForFile("content", "iVBORw0KGgoAAAANSUhEUgAAA", "screenshot");
    expect(out?.filename).toMatch(/^screenshot\./);
  });

  test("Base64 suffix stripped from filename", () => {
    const out = sniffStringForFile("imageBase64", "iVBORw0KGgoAAAANSUhEUgAAA", undefined);
    expect(out?.filename).toBe("image.png");
  });
});

describe("collectArtifacts", () => {
  test("detects screenshot.url-style payload (data.imageBase64)", () => {
    const response = {
      content: "Captured screenshot of https://example.com (8136 bytes)",
      data: { imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAlgAAAJYCAYAAAC" },
    };
    const out = collectArtifacts(response);
    expect(out).toHaveLength(1);
    expect(out[0]!.mimeType).toBe("image/png");
    expect(out[0]!.filename).toMatch(/\.png$/);
  });

  test("detects chart.svg-style payload (content holds SVG markup)", () => {
    const response = {
      content: '<svg width="380" height="300"><rect x="0" y="0" width="100" height="100"/></svg>',
      data: { width: 380, height: 300 },
    };
    const out = collectArtifacts(response);
    expect(out).toHaveLength(1);
    expect(out[0]!.mimeType).toBe("image/svg+xml");
  });

  test("detects canonical {filename, mimeType, contentBase64} shape", () => {
    const response = {
      data: {
        artifact: {
          filename: "report.pdf",
          mimeType: "application/pdf",
          contentBase64: "JVBERi0xLjQKJeLjz9MK",
          description: "Q3 financial report",
        },
      },
    };
    const out = collectArtifacts(response);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe("report.pdf");
    expect(out[0]!.description).toBe("Q3 financial report");
  });

  test("no artifact for content that's plain text only", () => {
    const response = {
      content: "No results found for 'quantum computing'",
      data: { results: [] },
    };
    const out = collectArtifacts(response);
    expect(out).toHaveLength(0);
  });

  test("handles nested arrays of artifacts", () => {
    const response = {
      data: {
        screenshots: [
          { filename: "step1.png", mimeType: "image/png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAA" },
          { filename: "step2.png", mimeType: "image/png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAA" },
        ],
      },
    };
    const out = collectArtifacts(response);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.filename)).toEqual(["step1.png", "step2.png"]);
  });
});
