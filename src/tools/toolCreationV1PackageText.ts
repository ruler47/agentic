import type { ToolPackageManifest } from "./toolPackage.js";
import type { ToolCreationV1Result } from "./toolCreationV1.js";

export function packageToolContract(): string {
  return [
    "export type ToolInput = Record<string, unknown>;",
    "export type ToolResult = { ok: boolean; content: string; data?: unknown };",
    "export type ToolSchema = { type: \"object\"; properties: Record<string, unknown>; required?: string[] };",
    "export type ToolStartupMode = \"always-on\" | \"on-demand\" | \"ephemeral\";",
    "export type ToolHealth = { ok: boolean; detail: string };",
    "export type ToolServiceHandle = { stop?(): Promise<void> | void; healthcheck?(): Promise<ToolHealth> | ToolHealth };",
    "export type Tool = {",
    "  name: string;",
    "  displayName?: string;",
    "  version?: string;",
    "  description: string;",
    "  capabilities: string[];",
    "  startupMode?: ToolStartupMode;",
    "  inputSchema?: ToolSchema;",
    "  outputSchema?: ToolSchema;",
    "  run(input: ToolInput, context?: unknown): Promise<ToolResult> | ToolResult;",
    "  healthcheck?(): Promise<ToolHealth> | ToolHealth;",
    "  startService?(context?: unknown): Promise<ToolServiceHandle | void> | ToolServiceHandle | void;",
    "};",
    "",
  ].join("\n");
}

export function renderReadme(input: ToolCreationV1Result["input"], manifest: Omit<ToolPackageManifest, "package">): string {
  const dependencies = Object.keys(input.dependencies).length > 0
    ? Object.entries(input.dependencies).map(([name, range]) => `- \`${name}\`: \`${range}\``).join("\n")
    : "- No runtime npm dependencies declared.";
  return [
    `# ${input.displayName ?? input.name}`,
    "",
    input.description,
    "",
    "## Operator Request",
    "",
    input.request ?? "Created from structured Tool Creation V1 input.",
    "",
    "## Runtime",
    "",
    [
      "- Exports `tool` from `dist/index.js`.",
      "- Runs as a portable source-bundle package outside Agentic app source.",
      "- Owns its npm dependencies inside this package workspace.",
      "- Starts disabled/loaded until an operator manually verifies and enables it.",
    ].join("\n"),
    "",
    "## Dependencies",
    "",
    dependencies,
    "",
    "## Schemas",
    "",
    `\`\`\`json\n${JSON.stringify({ input: manifest.inputSchema, output: manifest.outputSchema }, null, 2)}\n\`\`\``,
  ].join("\n");
}
