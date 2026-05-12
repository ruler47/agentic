/**
 * Phase 16 Slice H: best-effort detection of file-shaped payloads
 * inside a manual-run tool response. Council-built tools return
 * their bytes under ad-hoc keys (`imageBase64`, `pdfBase64`, `svg`,
 * `html`, …) instead of the canonical {filename, mimeType,
 * contentBase64} shape, so the Tools-page download UI used to
 * ignore them. The helpers below sniff:
 *
 *   - text payloads via leading markers (SVG `<svg`, HTML
 *     `<!DOCTYPE html`, …);
 *   - base64-encoded binaries via standard magic prefixes (PNG
 *     `iVBORw0K`, JPEG `/9j/`, PDF `JVBERi0`, ZIP `UEsDBB`, …);
 *   - hint-keyed bytes (`imageBase64`, `pdfBase64`) that we cannot
 *     identify by magic — emitted as application/octet-stream so
 *     the operator can still grab them.
 *
 * Both helpers are pure and dependency-free; they are unit-tested
 * directly in `artifactSniff.test.ts`.
 */

export type ManualRunArtifact = {
  filename: string;
  mimeType: string;
  content?: string;
  contentBase64?: string;
  description?: string;
};

export function collectArtifacts(value: unknown): ManualRunArtifact[] {
  const out: ManualRunArtifact[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, keyHint?: string): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const candidate = node as Record<string, unknown>;
    const filename = typeof candidate.filename === "string" ? candidate.filename : undefined;
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : undefined;
    const inlineContent =
      typeof candidate.content === "string" ? (candidate.content as string) : undefined;
    const base64 =
      typeof candidate.contentBase64 === "string" ? (candidate.contentBase64 as string) : undefined;
    const isCanonical =
      Boolean(filename) && Boolean(mimeType) && (inlineContent !== undefined || base64 !== undefined);
    if (isCanonical) {
      out.push({
        filename: filename!,
        mimeType: mimeType!,
        content: inlineContent,
        contentBase64: base64,
        description:
          typeof candidate.description === "string" ? (candidate.description as string) : undefined,
      });
    }
    for (const [childKey, childValue] of Object.entries(candidate)) {
      // Skip sniffing the canonical fields when this node is already
      // a {filename, mimeType, content/contentBase64} record —
      // otherwise the same payload is added twice (once via the
      // canonical push above, once via sniffing the inner string).
      if (
        isCanonical &&
        (childKey === "content" || childKey === "contentBase64" ||
          childKey === "filename" || childKey === "mimeType" ||
          childKey === "description")
      ) {
        continue;
      }
      if (typeof childValue === "string") {
        const sniffed = sniffStringForFile(childKey, childValue, keyHint);
        if (sniffed) out.push(sniffed);
      } else {
        visit(childValue, childKey);
      }
    }
  };
  visit(value);
  return out;
}

export function sniffStringForFile(
  key: string,
  value: string,
  parentKey: string | undefined,
): ManualRunArtifact | undefined {
  if (value.length < 16) return undefined;
  const trimmed = value.trimStart();
  const lowerKey = key.toLowerCase();
  const sanitisedKey = key.replace(/Base64$/i, "").replace(/_/g, "-").trim();
  const genericKey = !sanitisedKey || /^(content|value|data|payload|result)$/i.test(sanitisedKey);
  const baseName = genericKey
    ? (parentKey?.replace(/_/g, "-") ?? sanitisedKey ?? "output")
    : sanitisedKey;

  // --- text payloads (not base64) ---
  if (trimmed.startsWith("<svg") || /^<\?xml[^>]+svg/i.test(trimmed)) {
    return {
      filename: `${baseName || "output"}.svg`,
      mimeType: "image/svg+xml",
      content: value,
    };
  }
  if (trimmed.startsWith("<!DOCTYPE html") || /^<html[\s>]/i.test(trimmed)) {
    return {
      filename: `${baseName || "output"}.html`,
      mimeType: "text/html",
      content: value,
    };
  }

  // --- base64-encoded binaries ---
  const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 128));
  if (!looksBase64) return undefined;
  const head = value.slice(0, 16);
  const hinted = /base64|bytes|image|pdf|png|jpeg|jpg|gif|webp|zip|file/i.test(lowerKey);
  let mimeType: string | undefined;
  let extension: string | undefined;
  if (head.startsWith("iVBORw0K")) {
    mimeType = "image/png";
    extension = "png";
  } else if (head.startsWith("/9j/")) {
    mimeType = "image/jpeg";
    extension = "jpg";
  } else if (head.startsWith("R0lGODl")) {
    mimeType = "image/gif";
    extension = "gif";
  } else if (head.startsWith("UklGR")) {
    mimeType = "image/webp";
    extension = "webp";
  } else if (head.startsWith("JVBERi0")) {
    mimeType = "application/pdf";
    extension = "pdf";
  } else if (head.startsWith("UEsDBB")) {
    mimeType = "application/zip";
    extension = "zip";
  } else if (hinted) {
    mimeType = "application/octet-stream";
    extension = "bin";
  } else {
    return undefined;
  }
  return {
    filename: `${baseName || "output"}.${extension}`,
    mimeType,
    contentBase64: value,
  };
}
