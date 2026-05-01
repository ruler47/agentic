import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { Tool, ToolInput, ToolResult } from "./tool.js";

type SafeWorkspacePathResult = { ok: true; path: string } | { ok: false; content: string };

export class FileReadTool implements Tool {
  readonly name = "file.read";
  readonly version = "1.0.0";
  readonly description = "Reads a UTF-8 text file from the agent workspace.";
  readonly capabilities = ["file-read", "coding", "documents", "artifacts"];
  readonly startupMode = "always-on";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", minLength: 1 },
    },
    required: ["path"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly workspaceRoot = defaultWorkspaceRoot()) {}

  async healthcheck() {
    return { ok: true, detail: `Workspace root: ${this.workspaceRoot}` };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) return { ok: false, content: "Missing file path." };

    const safePath = safeWorkspacePath(this.workspaceRoot, filePath);
    if (!safePath.ok) return { ok: false, content: safePath.content };

    try {
      return {
        ok: true,
        content: await readFile(safePath.path, "utf8"),
        data: { path: relative(this.workspaceRoot, safePath.path) },
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "File read failed.",
      };
    }
  }
}

export class FileWriteTool implements Tool {
  readonly name = "file.write";
  readonly version = "1.0.0";
  readonly description = "Writes a UTF-8 text file inside the agent workspace.";
  readonly capabilities = ["file-write", "coding", "documents", "artifacts"];
  readonly startupMode = "always-on";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
    required: ["path", "content"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly workspaceRoot = defaultWorkspaceRoot()) {}

  async healthcheck() {
    return { ok: true, detail: `Workspace root: ${this.workspaceRoot}` };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    const content = typeof input.content === "string" ? input.content : undefined;
    if (!filePath) return { ok: false, content: "Missing file path." };
    if (content === undefined) return { ok: false, content: "Missing file content." };

    const safePath = safeWorkspacePath(this.workspaceRoot, filePath);
    if (!safePath.ok) return { ok: false, content: safePath.content };

    await mkdir(dirname(safePath.path), { recursive: true });
    await writeFile(safePath.path, content, "utf8");

    return {
      ok: true,
      content: `Wrote ${relative(this.workspaceRoot, safePath.path)}.`,
      data: { path: relative(this.workspaceRoot, safePath.path), bytes: Buffer.byteLength(content) },
    };
  }
}

function defaultWorkspaceRoot(): string {
  return resolve(process.env.FILE_TOOL_ROOT ?? "workspace");
}

function safeWorkspacePath(
  workspaceRoot: string,
  filePath: string,
): SafeWorkspacePathResult {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, filePath);
  const relativePath = relative(root, resolved);

  if (relativePath.startsWith("..") || relativePath === "" || resolved === root) {
    return { ok: false, content: "Path must stay inside the workspace and point to a file." };
  }

  return { ok: true, path: resolved };
}
