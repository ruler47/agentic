import type { ToolContextInput } from "@/api/tools";

export async function readToolContextFiles(files: File[], limit = 8): Promise<ToolContextInput[]> {
  const chunks: ToolContextInput[] = [];
  for (const file of files.slice(0, limit)) {
    const text = await file.text();
    if (!text.trim()) continue;
    chunks.push({
      kind: inferFileContextKind(file.name, file.type),
      title: file.name,
      content: text,
      source: `uploaded-file:${file.name}`,
      mimeType: file.type || inferMimeType(file.name),
    });
  }
  return chunks;
}

export function contextItemsFromDocsUrls(urls: string[] | undefined): ToolContextInput[] {
  return (urls ?? []).map((url) => ({
    kind: "docs-url",
    title: url,
    content: url,
    source: "tool-form:docs-url",
  }));
}

function inferFileContextKind(fileName: string, mimeType: string): ToolContextInput["kind"] {
  if (/openapi|swagger|\.ya?ml$|\.json$/i.test(fileName) || /json|ya?ml/i.test(mimeType)) {
    return "openapi";
  }
  return "file";
}

function inferMimeType(fileName: string): string | undefined {
  if (/\.json$/i.test(fileName)) return "application/json";
  if (/\.ya?ml$/i.test(fileName)) return "application/yaml";
  if (/\.md$/i.test(fileName)) return "text/markdown";
  if (/\.txt$/i.test(fileName)) return "text/plain";
  return undefined;
}
