/**
 * Phase 14: `ToolBuildCouncilAdapter` implementation that wires the
 * agent council to real persistence + filesystem + registry. Kept
 * outside `src/agents/universalAgent.ts` so the agent class stays
 * dependency-light.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CodingCouncilStore } from "../settings/codingCouncilStore.js";
import type { ModelTierSettingsStore } from "../settings/modelTierSettings.js";
import type { ToolMetadataStore } from "./toolMetadataStore.js";
import type { Tool } from "./tool.js";
import type { ToolBuildCouncilAdapter } from "../agents/universalAgent.js";
import {
  COUNCIL_TOOL_BODY_PATH,
  extractToolBody,
  renderCouncilScaffold,
} from "../agents/councilScaffold.js";

export type CouncilToolAdapterDeps = {
  instanceId?: string;
  toolsRoot?: string;
  codingCouncilStore: CodingCouncilStore;
  modelTierSettings: ModelTierSettingsStore;
  metadataStore: ToolMetadataStore;
  /** Optional hot-reload hook (provided by runtime-workers). */
  reloadGeneratedTools?: () => Promise<void>;
  /** QA runner — usually `ToolsService.runToolManually`. */
  runToolManually: (
    toolName: string,
    body: { input: Record<string, unknown> },
  ) => Promise<{ result: { ok: boolean; content: string; data?: unknown } }>;
  /**
   * Returns the live Tool object for a registered name (or undefined).
   * Used after `reloadGeneratedTools` to backfill metadata fields the
   * adapter can't extract from the TS source — primarily inputSchema
   * and outputSchema, which the council embeds in the Tool definition
   * but the metadata row stays empty without this lookup.
   */
  getRegisteredTool?: (name: string) => Pick<Tool, "inputSchema" | "outputSchema" | "examples" | "requiredSecretHandles"> | undefined;
  /**
   * Fires after a successful council registration. RunsService uses
   * this to wake any parent tool-build runs that were waiting on a
   * capability the newly-registered tool provides (Phase 2:
   * auto-resume after a sub-build finishes its reader tool).
   */
  onToolRegistered?: (toolName: string, capabilities: readonly string[]) => Promise<void>;
};

export class CouncilToolAdapter implements ToolBuildCouncilAdapter {
  private readonly instanceId: string;
  private readonly toolsRoot: string;

  constructor(private readonly deps: CouncilToolAdapterDeps) {
    this.instanceId = deps.instanceId ?? "instance-local";
    this.toolsRoot = resolve(deps.toolsRoot ?? "tools");
  }

  async resolveConfig() {
    return this.deps.codingCouncilStore.get(this.instanceId);
  }

  async resolveCouncilModels(tier: string): Promise<string[]> {
    const rows = await this.deps.modelTierSettings.list();
    const row = rows.find((entry) => entry.tier === tier);
    return row?.models ?? [];
  }

  async registerToolFromFiles(
    toolName: string,
    files: ReadonlyArray<{ path: string; content: string }>,
    metadata: {
      description: string;
      version?: string;
      secretHandle?: string;
      /**
       * Optional sample input — the QA-input-synthesizer's output for
       * this tool. Persisted as a metadata `example` so the Tools-page
       * Manual Run form shows it as a pre-filled JSON sample. Without
       * this the operator gets `{}` and has to guess what shape the
       * tool wants.
       */
      sampleInput?: Record<string, unknown>;
      /** Extra capability tags to advertise besides the defaults. */
      requiredCapabilities?: string[];
    },
  ): Promise<{ toolName: string; version: string }> {
    const version = metadata.version ?? (await this.nextVersionFor(toolName));
    const sanitized = sanitizeName(toolName);
    const baseDir = join(this.toolsRoot, sanitized, version);

    // 1. Extract the model's Tool body and overlay it onto the canonical
    //    source-bundle scaffold (index.ts, runtime/server.ts, package.json,
    //    tsconfig.json, src/tools/tool.ts). The model only writes ONE file:
    //    the Tool definition itself — the runtime expects a precise layout
    //    that we own here instead of asking the model to reproduce.
    const toolBody = extractToolBody(files, sanitized);
    if (!toolBody) {
      throw new Error(
        `Council emitted no recognisable Tool body for ${toolName}. ` +
          `Expected ${COUNCIL_TOOL_BODY_PATH(sanitized)} or any .ts file with \`export const tool\`.`,
      );
    }

    const scaffold = renderCouncilScaffold({
      toolName,
      sanitizedName: sanitized,
      version,
      toolBody,
    });
    for (const file of scaffold) {
      const target = join(baseDir, sanitizeRelativePath(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }

    // 2. Register / replace metadata row. Use replacement when the tool
    //    already exists (rework / bugfix flow); otherwise register fresh.
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    // Deduplicate so we don't end up with two copies of `council-built`
    // if a sub-build asks for that exact tag too.
    const capabilities = Array.from(
      new Set([toolName, "council-built", ...(metadata.requiredCapabilities ?? [])]),
    );
    const baseInput = {
      name: toolName,
      version,
      description: metadata.description,
      capabilities,
      startupMode: "on-demand" as const,
      modulePath: join(baseDir, "index.ts"),
      requiredSecretHandles: metadata.secretHandle ? [metadata.secretHandle] : undefined,
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1" as const,
        name: toolName,
        version,
        description: metadata.description,
        capabilities,
        startupMode: "on-demand" as const,
        package: { type: "source-bundle" as const, ref: `${sanitized}/${version}` },
      },
      changeSummary: `Council-built version ${version}.`,
    };
    if (existing) {
      await this.deps.metadataStore.promoteReplacement({
        ...baseInput,
        replacesVersion: existing.version,
      });
    } else {
      await this.deps.metadataStore.registerGenerated(baseInput);
    }

    // 3. Refresh the in-process registry so the tool is callable
    //    immediately (the QA loop calls it via `runToolManually` next).
    await this.deps.reloadGeneratedTools?.();

    // 4. Backfill metadata with the schemas declared inside the Tool
    //    body. registerGenerated above only saw scaffold-level fields
    //    (name, version, description); the inputSchema / outputSchema /
    //    examples live inside the LLM-emitted TS file and surface only
    //    once the runtime imports it. We also persist the QA-synthesized
    //    sample input as an example so the Tools-page Manual Run form
    //    pre-fills it for the operator.
    const live = this.deps.getRegisteredTool?.(toolName);
    // Always-on backfill paths so the Tools page is useful even when
    // the tool failed to load (TS error, missing dep, etc.):
    //   - inputSchema falls back to regex-parsed schema from the body
    //   - examples falls back to the QA sampleInput if any
    const fallbackInputSchema = extractInputSchemaFromSource(toolBody);
    const exampleFromSample = metadata.sampleInput
      ? [{ title: "Synthesized QA input", input: metadata.sampleInput }]
      : undefined;
    const enriched = {
      ...baseInput,
      inputSchema: (live?.inputSchema ?? coerceInputSchema(fallbackInputSchema)),
      outputSchema: live?.outputSchema,
      examples:
        live?.examples && live.examples.length > 0
          ? live.examples
          : exampleFromSample,
      requiredSecretHandles:
        live?.requiredSecretHandles && live.requiredSecretHandles.length > 0
          ? live.requiredSecretHandles
          : baseInput.requiredSecretHandles,
    };
    // Same-version re-register is an in-place update on the metadata
    // store; promoteReplacement bumps versions and would loop.
    await this.deps.metadataStore.registerGenerated(enriched);

    // 5. Notify RunsService so it can wake any parent tool-build runs
    //    that were waiting on a capability this tool now provides
    //    (Phase 2 auto-resume). Best-effort — a failed callback must
    //    not retroactively fail the registration that just succeeded.
    if (this.deps.onToolRegistered) {
      try {
        await this.deps.onToolRegistered(toolName, capabilities);
      } catch {
        // ignore; the operator can manually resume from the Tool Builds page
      }
    }

    return { toolName, version };
  }

  async updateDescription(toolName: string, version: string, description: string): Promise<void> {
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing || existing.version !== version) return;
    await this.deps.metadataStore.registerGenerated({
      name: existing.name,
      displayName: existing.displayName,
      version: existing.version,
      description,
      capabilities: [...existing.capabilities],
      startupMode: existing.startupMode,
      inputSchema: existing.inputSchema,
      outputSchema: existing.outputSchema,
      modulePath: existing.modulePath,
      testPath: existing.testPath,
      requiredConfigurationKeys: existing.requiredConfigurationKeys,
      requiredSecretHandles: existing.requiredSecretHandles,
      settingsSchema: existing.settingsSchema,
      storage: existing.storage,
      docsMarkdown: existing.docsMarkdown,
      examples: existing.examples,
      packageManifest: existing.packageManifest,
      changeSummary: existing.changeSummary,
    });
  }

  async updateChangeSummary(toolName: string, version: string, changeSummary: string): Promise<void> {
    // Same-version registerGenerated is an in-place update — preserve
    // every field on the existing row and only swap `changeSummary`.
    // If the tool isn't in metadata anymore (operator deleted it
    // mid-run, etc.), silently drop.
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing || existing.version !== version) return;
    await this.deps.metadataStore.registerGenerated({
      name: existing.name,
      displayName: existing.displayName,
      version: existing.version,
      description: existing.description,
      capabilities: [...existing.capabilities],
      startupMode: existing.startupMode,
      inputSchema: existing.inputSchema,
      outputSchema: existing.outputSchema,
      modulePath: existing.modulePath,
      testPath: existing.testPath,
      requiredConfigurationKeys: existing.requiredConfigurationKeys,
      requiredSecretHandles: existing.requiredSecretHandles,
      settingsSchema: existing.settingsSchema,
      storage: existing.storage,
      docsMarkdown: existing.docsMarkdown,
      examples: existing.examples,
      packageManifest: existing.packageManifest,
      changeSummary,
    });
  }

  /**
   * Read the active version's Tool body from disk so the council can
   * apply a rework as an EDIT on top of the existing code instead of
   * regenerating from scratch (which has been silently dropping prior
   * fixes across rework chains).
   */
  async readCurrentToolSource(toolName: string): Promise<string | undefined> {
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing) return undefined;
    const sanitized = sanitizeName(toolName);
    const candidatePath = join(this.toolsRoot, sanitized, existing.version, "src", "tools", "generated", `${sanitized}Tool.ts`);
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(candidatePath, "utf8");
    } catch {
      return undefined;
    }
  }

  async runToolForQa(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string; data?: unknown }> {
    const response = await this.deps.runToolManually(toolName, { input });
    return response.result;
  }

  /** Pick the next semver bump for an existing tool, or `1.0.0` for a fresh one. */
  private async nextVersionFor(toolName: string): Promise<string> {
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing) return "1.0.0";
    const [maj, min, patch] = existing.version.split(".").map((segment) => Number.parseInt(segment, 10));
    const safeMaj = Number.isFinite(maj!) ? maj! : 1;
    const safeMin = Number.isFinite(min!) ? min! : 0;
    const safePatch = Number.isFinite(patch!) ? patch! : 0;
    return `${safeMaj}.${safeMin}.${safePatch + 1}`;
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "council_tool";
}

/**
 * Best-effort regex parse of the Tool body to extract the `inputSchema`
 * literal. Used as a fallback when the runtime fails to load the tool
 * (TS error, missing dep) — without this the Tools page shows
 * "(no declared properties)" and the operator can't even tell what the
 * tool's input shape is supposed to be. Returns undefined when the
 * literal can't be found or parsed.
 */
/**
 * Coerce a free-form JSON object into the strict ToolSchema shape that
 * the metadata store requires (`{ type: "object", properties, required? }`).
 * Returns undefined if the input isn't shaped like a JSON Schema object.
 */
function coerceInputSchema(value: Record<string, unknown> | undefined): import("./tool.js").ToolSchema | undefined {
  if (!value || typeof value !== "object") return undefined;
  const type = value.type;
  const properties = value.properties;
  if (type !== "object" || !properties || typeof properties !== "object") {
    return undefined;
  }
  const out: import("./tool.js").ToolSchema = {
    type: "object",
    properties: properties as Record<string, unknown>,
  };
  if (Array.isArray(value.required)) {
    out.required = (value.required as unknown[]).filter((entry): entry is string => typeof entry === "string");
  }
  return out;
}

function extractInputSchemaFromSource(source: string): Record<string, unknown> | undefined {
  // Find an inline `inputSchema: { ... }`. If the LLM used a separate
  // `const inputSchema = { ... }` declaration and then shorthand'd it
  // (`inputSchema,`) inside the Tool literal — which both gemma and
  // qwen do regularly — fall back to that pattern.
  const inline = source.match(/inputSchema\s*:\s*\{/);
  const decl = source.match(/(?:const|let|var)\s+inputSchema\s*[:=][^{]*\{/);
  const marker = inline ?? decl;
  if (!marker || marker.index === undefined) return undefined;
  // Locate the `{` that starts the schema literal.
  const matchedText = marker[0];
  const braceOffsetInMatch = matchedText.lastIndexOf("{");
  if (braceOffsetInMatch < 0) return undefined;
  const start = marker.index + braceOffsetInMatch;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(start, i + 1);
        // Convert simple TS object literal → JSON. Two heuristics that
        // cover what LLMs emit in practice:
        //   - quote unquoted keys: `{ text: { type: "string" } }` → `{"text":{"type":"string"}}`
        //   - strip trailing commas before } or ]
        const jsonish = literal
          .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
          .replace(/,(\s*[}\]])/g, "$1")
          // Single-quoted strings → double-quoted.
          .replace(/'([^'\\]*)'/g, '"$1"');
        try {
          return JSON.parse(jsonish) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function sanitizeRelativePath(value: string): string {
  // Disallow absolute paths and `..` segments — the writeFile must stay
  // inside the tool's directory.
  const normalized = value.replace(/^[/\\]+/, "");
  const parts = normalized.split(/[/\\]+/).filter((segment) => segment && segment !== "..");
  return parts.join("/") || "file.txt";
}
