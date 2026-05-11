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
    metadata: { description: string; version?: string; secretHandle?: string },
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
    const baseInput = {
      name: toolName,
      version,
      description: metadata.description,
      capabilities: [toolName, "council-built"],
      startupMode: "on-demand" as const,
      modulePath: join(baseDir, "index.ts"),
      requiredSecretHandles: metadata.secretHandle ? [metadata.secretHandle] : undefined,
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1" as const,
        name: toolName,
        version,
        description: metadata.description,
        capabilities: [toolName, "council-built"],
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
    //    once the runtime imports it. Without this step the Tools page
    //    shows "(no declared properties)" even when the tool body
    //    declares a full JSON schema.
    const live = this.deps.getRegisteredTool?.(toolName);
    if (live) {
      const enriched = {
        ...baseInput,
        inputSchema: live.inputSchema,
        outputSchema: live.outputSchema,
        examples: live.examples,
        requiredSecretHandles:
          live.requiredSecretHandles && live.requiredSecretHandles.length > 0
            ? live.requiredSecretHandles
            : baseInput.requiredSecretHandles,
      };
      // Same-version re-register is an in-place update on the metadata
      // store; promoteReplacement bumps versions and would loop.
      await this.deps.metadataStore.registerGenerated(enriched);
    }

    return { toolName, version };
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

function sanitizeRelativePath(value: string): string {
  // Disallow absolute paths and `..` segments — the writeFile must stay
  // inside the tool's directory.
  const normalized = value.replace(/^[/\\]+/, "");
  const parts = normalized.split(/[/\\]+/).filter((segment) => segment && segment !== "..");
  return parts.join("/") || "file.txt";
}
