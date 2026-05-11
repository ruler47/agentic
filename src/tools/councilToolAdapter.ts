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
import type { ToolBuildCouncilAdapter } from "../agents/universalAgent.js";

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
    const baseDir = join(this.toolsRoot, sanitizeName(toolName), version);

    // 1. Write source-bundle files to disk so tool-package-runner can pick
    //    them up. Tool authors may emit nested paths (e.g. src/server.ts),
    //    so create parent dirs as needed.
    for (const file of files) {
      const safe = sanitizeRelativePath(file.path);
      const target = join(baseDir, safe);
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
      modulePath: join(baseDir, "src/server.ts"),
      requiredSecretHandles: metadata.secretHandle ? [metadata.secretHandle] : undefined,
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1" as const,
        name: toolName,
        version,
        description: metadata.description,
        capabilities: [toolName, "council-built"],
        startupMode: "on-demand" as const,
        package: { type: "source-bundle" as const, ref: `${sanitizeName(toolName)}/${version}` },
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
