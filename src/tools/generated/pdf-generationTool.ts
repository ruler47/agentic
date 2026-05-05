import { Tool, ToolInput, ToolResult } from "../tool.js";

type PdfArtifactData = {
  artifact: {
    filename: string;
    mimeType: "application/pdf";
    contentBase64: string;
    description: string;
  };
};

export const tool: Tool = {
  name: "generated.pdf.generation",
  version: "1.0.0",
  description: "Renders plain text or Markdown-like content into a downloadable PDF artifact payload.",
  capabilities: [...new Set(["pdf-generation", "document-generation", "pdf-generation", "artifact-generation"])],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      markdown: { type: "string" },
      task: { type: "string" },
      context: { type: "string" },
      filename: { type: "string" }
    }
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object", properties: { artifact: { type: "object" } } }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Document artifact renderer is importable." };
  },
  async run(input: ToolInput): Promise<ToolResult> {
    const title = textValue(input.title) || "Agentic Report";
    const body = [input.content, input.markdown, input.context, input.task]
      .map(textValue)
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) {
      return { ok: false, content: "document generation requires content, markdown, context, or task text." };
    }

    const filename = safePdfFilename(textValue(input.filename) || title);
    const pdf = renderSimplePdf(title, body);
    const data: PdfArtifactData = {
      artifact: {
        filename,
        mimeType: "application/pdf",
        contentBase64: pdf.toString("base64"),
        description: "Generated PDF document artifact: " + title
      }
    };

    return {
      ok: true,
      content: "Generated PDF document artifact " + filename + ".",
      data
    };
  }
};

export default tool;

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safePdfFilename(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agentic-report";
  return slug.endsWith(".pdf") ? slug : slug + ".pdf";
}

function renderSimplePdf(title: string, body: string): Buffer {
  const lines = wrapLines([title, "", ...body.split(/\r?\n/)].join("\n"), 92).slice(0, 52);
  const escapedLines = lines.map(escapePdfText);
  const textCommands = [
    "BT",
    "/F1 12 Tf",
    "50 792 Td",
    "14 TL",
    ...escapedLines.map((line, index) => index === 0 ? "(" + line + ") Tj" : "T* (" + line + ") Tj"),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(textCommands, "utf8") + " >>\nstream\n" + textCommands + "\nendstream"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += String(index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += "xref\n0 " + (objects.length + 1) + "\n";
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += String(offsets[index]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\n";
  pdf += "startxref\n" + xrefOffset + "\n%%EOF\n";
  return Buffer.from(pdf, "utf8");
}

function wrapLines(value: string, width: number): string[] {
  const result: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const words = rawLine.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) {
      result.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > width) {
        result.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
    }
    result.push(line);
  }
  return result;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
