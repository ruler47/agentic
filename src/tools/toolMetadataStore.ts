import { Tool, ToolExample, ToolHealth, ToolSchema, ToolStartupMode, ToolStorageContract } from "./tool.js";
import type { ToolPackageManifest } from "./toolPackage.js";

export type ToolModuleSource = "builtin" | "generated";
export type ToolModuleStatus = "available" | "disabled" | "failed";

export type ToolModulePromotionEvidence = {
  status: "promoted";
  promotedAt: string;
  summary: string;
  buildRequestId?: string;
  qaReport?: Record<string, unknown>;
  packageRef?: string;
  migrationIds?: string[];
};

export type ToolModuleVersionSummary = {
  version: string;
  active: boolean;
  status: ToolModuleStatus;
  displayName?: string;
  description?: string;
  capabilities?: string[];
  modulePath?: string;
  testPath?: string;
  requiredSecretHandles?: string[];
  changeSummary?: string;
  promotionEvidence?: ToolModulePromotionEvidence;
  packageManifest?: ToolPackageManifest;
  lastHealthDetail?: string;
  successCount?: number;
  failureCount?: number;
  updatedAt: string;
};

export type ToolModuleMetadata = {
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode: ToolStartupMode;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  modulePath?: string;
  testPath?: string;
  source: ToolModuleSource;
  status: ToolModuleStatus;
  lastHealthOk?: boolean;
  lastHealthDetail?: string;
  requiredConfigurationKeys: string[];
  requiredSecretHandles: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  changeSummary?: string;
  promotionEvidence?: ToolModulePromotionEvidence;
  examples: ToolExample[];
  packageManifest?: ToolPackageManifest;
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  updatedAt: string;
  versions?: ToolModuleVersionSummary[];
};

export type GeneratedToolModuleInput = {
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode?: ToolStartupMode;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  modulePath?: string;
  testPath?: string;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  changeSummary?: string;
  promotionEvidence?: ToolModulePromotionEvidence;
  examples?: ToolExample[];
  packageManifest?: ToolPackageManifest;
};

export type GeneratedToolReplacementInput = GeneratedToolModuleInput & {
  replacesVersion: string;
};

export type ToolMetadataStore = {
  list(): Promise<ToolModuleMetadata[]>;
  listVersions(name: string): Promise<ToolModuleVersionSummary[]>;
  syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]>;
  updateHealth(name: string, health: ToolHealth): Promise<void>;
  recordUsage(name: string, outcome: "success" | "failure", at?: Date): Promise<void>;
  registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata>;
  promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata>;
  activateVersion(name: string, version: string): Promise<ToolModuleMetadata>;
  /**
   * Phase 16 Slice G: flip a generated tool's status from "disabled"
   * (its initial state after `registerGenerated`/`promoteReplacement`)
   * to "available". Called by the council pipeline once QA has
   * actually passed, so the Tools page no longer shows
   * green-runtime-but-red-status mismatches. No-op for builtins.
   */
  markAvailable(name: string, version: string): Promise<void>;
  deleteGenerated(name: string): Promise<boolean>;
};

export class InMemoryToolMetadataStore implements ToolMetadataStore {
  private readonly modules = new Map<string, ToolModuleMetadata>();

  constructor(initialModules: ToolModuleMetadata[] = []) {
    for (const item of initialModules) {
      this.modules.set(item.name, cloneModule(item));
    }
  }

  async list(): Promise<ToolModuleMetadata[]> {
    return [...this.modules.values()]
      .map((item) => ({ ...cloneModule(item), versions: this.versionsFor(item.name, item.version) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVersions(name: string): Promise<ToolModuleVersionSummary[]> {
    const existing = this.modules.get(name);
    return existing ? this.versionsFor(name, existing.version) : [];
  }

  async syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]> {
    const updatedAt = new Date().toISOString();

    for (const tool of tools) {
      const existing = this.modules.get(tool.name);
      this.modules.set(tool.name, {
        name: tool.name,
        displayName: tool.displayName ?? existing?.displayName,
        version: tool.version ?? "0.0.0",
        description: tool.description,
        capabilities: [...tool.capabilities],
        startupMode: tool.startupMode ?? "on-demand",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        requiredConfigurationKeys: tool.requiredConfigurationKeys ?? existing?.requiredConfigurationKeys ?? [],
        requiredSecretHandles: tool.requiredSecretHandles ?? existing?.requiredSecretHandles ?? [],
        settingsSchema: tool.settingsSchema ?? existing?.settingsSchema,
        storage: tool.storage ?? existing?.storage,
        docsMarkdown: tool.docsMarkdown ?? existing?.docsMarkdown,
        examples: tool.examples ?? existing?.examples ?? [],
        successCount: existing?.successCount ?? 0,
        failureCount: existing?.failureCount ?? 0,
        lastSuccessAt: existing?.lastSuccessAt,
        lastFailureAt: existing?.lastFailureAt,
        source: "builtin",
        status: existing?.status ?? "available",
        lastHealthOk: existing?.lastHealthOk,
        lastHealthDetail: existing?.lastHealthDetail,
        updatedAt,
      });
    }

    return this.list();
  }

  async updateHealth(name: string, health: ToolHealth): Promise<void> {
    const existing = this.modules.get(name);
    if (!existing) return;

    this.modules.set(name, {
      ...existing,
      status: health.ok ? "available" : "failed",
      lastHealthOk: health.ok,
      lastHealthDetail: health.detail,
      updatedAt: new Date().toISOString(),
    });
  }

  async recordUsage(name: string, outcome: "success" | "failure", at = new Date()): Promise<void> {
    const existing = this.modules.get(name);
    if (!existing) return;

    const timestamp = at.toISOString();
    this.modules.set(name, {
      ...existing,
      successCount: existing.successCount + (outcome === "success" ? 1 : 0),
      failureCount: existing.failureCount + (outcome === "failure" ? 1 : 0),
      lastSuccessAt: outcome === "success" ? timestamp : existing.lastSuccessAt,
      lastFailureAt: outcome === "failure" ? timestamp : existing.lastFailureAt,
      updatedAt: timestamp,
    });
  }

  async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(input.name);
    if (existing?.source === "builtin") {
      throw new Error(`Cannot register generated tool ${input.name}: a builtin tool already uses that name.`);
    }
    if (existing && existing.version !== input.version) {
      throw new Error(
        `Cannot register generated tool ${input.name}: existing version ${existing.version} differs from ${input.version}.`,
      );
    }

    const stored: ToolModuleMetadata = {
      name: input.name,
      displayName: input.displayName ?? existing?.displayName,
      version: input.version,
      description: input.description,
      capabilities: [...input.capabilities],
      startupMode: input.startupMode ?? "on-demand",
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      modulePath: input.modulePath,
      testPath: input.testPath,
      requiredConfigurationKeys: input.requiredConfigurationKeys ?? existing?.requiredConfigurationKeys ?? [],
      requiredSecretHandles: input.requiredSecretHandles ?? existing?.requiredSecretHandles ?? [],
      settingsSchema: input.settingsSchema ?? existing?.settingsSchema,
      storage: input.storage ?? existing?.storage,
      docsMarkdown: input.docsMarkdown ?? existing?.docsMarkdown,
      changeSummary: input.changeSummary ?? existing?.changeSummary,
      promotionEvidence: input.promotionEvidence ?? existing?.promotionEvidence,
      examples: input.examples ?? existing?.examples ?? [],
      packageManifest: input.packageManifest ?? existing?.packageManifest,
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      lastSuccessAt: existing?.lastSuccessAt,
      lastFailureAt: existing?.lastFailureAt,
      source: "generated",
      status: "disabled",
      lastHealthOk: existing?.lastHealthOk,
      lastHealthDetail: existing?.lastHealthDetail,
      updatedAt: new Date().toISOString(),
    };
    this.modules.set(stored.name, cloneModule(stored));

    return { ...cloneModule(stored), versions: this.versionsFor(stored.name, stored.version) };
  }

  async promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(input.name);
    validateReplacement(input, existing);
    if (!existing) {
      throw new Error(`Cannot promote replacement for ${input.name}: no installed generated tool exists.`);
    }

    const stored: ToolModuleMetadata = {
      name: input.name,
      displayName: input.displayName ?? existing.displayName,
      version: input.version,
      description: input.description,
      capabilities: [...input.capabilities],
      startupMode: input.startupMode ?? "on-demand",
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      modulePath: input.modulePath,
      testPath: input.testPath,
      requiredConfigurationKeys: input.requiredConfigurationKeys ?? [],
      requiredSecretHandles: input.requiredSecretHandles ?? [],
      settingsSchema: input.settingsSchema,
      storage: input.storage,
      docsMarkdown: input.docsMarkdown,
      changeSummary: input.changeSummary,
      promotionEvidence: input.promotionEvidence,
      examples: input.examples ?? [],
      packageManifest: input.packageManifest,
      successCount: existing.successCount,
      failureCount: existing.failureCount,
      lastSuccessAt: existing.lastSuccessAt,
      lastFailureAt: existing.lastFailureAt,
      source: "generated",
      status: "disabled",
      updatedAt: new Date().toISOString(),
    };
    this.modules.set(stored.name, cloneModule(stored));

    return { ...cloneModule(stored), versions: this.versionsFor(stored.name, stored.version) };
  }

  async activateVersion(name: string, version: string): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(name);
    if (!existing) throw new Error(`Generated tool ${name} was not found.`);
    if (existing.source === "builtin") throw new Error(`Cannot switch builtin tool ${name}.`);
    if (existing.version !== version) {
      throw new Error(
        `Version ${version} for ${name} is not available in the in-memory registry after restart; rebuild or re-promote it first.`,
      );
    }
    return { ...cloneModule(existing), versions: this.versionsFor(name, existing.version) };
  }

  async markAvailable(name: string, version: string): Promise<void> {
    const existing = this.modules.get(name);
    if (!existing) return;
    if (existing.source === "builtin") return;
    if (existing.version !== version) return;
    const updated: ToolModuleMetadata = {
      ...cloneModule(existing),
      status: "available",
      updatedAt: new Date().toISOString(),
    };
    this.modules.set(name, updated);
  }

  async deleteGenerated(name: string): Promise<boolean> {
    const existing = this.modules.get(name);
    if (!existing) return false;
    if (existing.source === "builtin") {
      throw new Error(`Cannot delete builtin tool ${name}.`);
    }
    return this.modules.delete(name);
  }

  private versionsFor(name: string, activeVersion: string): ToolModuleVersionSummary[] {
    const module = this.modules.get(name);
    if (!module) return [];
    return [
      {
        version: module.version,
        active: module.version === activeVersion,
        status: module.status,
        displayName: module.displayName,
        description: module.description,
        capabilities: [...module.capabilities],
        modulePath: module.modulePath,
        testPath: module.testPath,
        requiredSecretHandles: [...(module.requiredSecretHandles ?? [])],
        changeSummary: module.changeSummary,
        promotionEvidence: module.promotionEvidence ? cloneJson(module.promotionEvidence) : undefined,
        packageManifest: module.packageManifest ? cloneJson(module.packageManifest) : undefined,
        lastHealthDetail: module.lastHealthDetail,
        successCount: module.successCount,
        failureCount: module.failureCount,
        updatedAt: module.updatedAt,
      },
    ];
  }
}

export function toolToMetadata(tool: Tool, updatedAt = new Date().toISOString()): ToolModuleMetadata {
  return {
    name: tool.name,
    displayName: tool.displayName,
    version: tool.version ?? "0.0.0",
    description: tool.description,
    capabilities: [...tool.capabilities],
    startupMode: tool.startupMode ?? "on-demand",
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    requiredConfigurationKeys: tool.requiredConfigurationKeys ?? [],
    requiredSecretHandles: tool.requiredSecretHandles ?? [],
    settingsSchema: tool.settingsSchema,
    storage: tool.storage,
    docsMarkdown: tool.docsMarkdown,
    changeSummary: "Builtin tool synced from source.",
    examples: tool.examples ?? [],
    packageManifest: undefined,
    successCount: 0,
    failureCount: 0,
    source: "builtin",
    status: "available",
    updatedAt,
  };
}

export function generatedToolInputFromPackageManifest(
  manifest: ToolPackageManifest,
  changeSummary?: string,
): GeneratedToolModuleInput {
  return {
    name: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    description: manifest.description,
    capabilities: [...manifest.capabilities],
    startupMode: manifest.startupMode,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    modulePath: manifest.package.type === "local-path" ? manifest.package.ref : undefined,
    requiredConfigurationKeys: manifest.requiredConfigurationKeys,
    requiredSecretHandles: manifest.requiredSecretHandles,
    settingsSchema: manifest.settingsSchema,
    storage: manifest.storage,
    docsMarkdown: manifest.docsMarkdown,
    examples: manifest.examples as ToolExample[] | undefined,
    packageManifest: manifest,
    changeSummary:
      changeSummary ??
      `Imported portable tool package manifest ${manifest.name}@${manifest.version} from ${manifest.package.type}:${manifest.package.ref}.`,
  };
}

function cloneModule(module: ToolModuleMetadata): ToolModuleMetadata {
  return {
    ...module,
    capabilities: [...module.capabilities],
    inputSchema: module.inputSchema ? { ...module.inputSchema } : undefined,
    outputSchema: module.outputSchema ? { ...module.outputSchema } : undefined,
    requiredConfigurationKeys: [...(module.requiredConfigurationKeys ?? [])],
    requiredSecretHandles: [...(module.requiredSecretHandles ?? [])],
    settingsSchema: module.settingsSchema ? { ...module.settingsSchema } : undefined,
    storage: module.storage ? cloneJson(module.storage) : undefined,
    promotionEvidence: module.promotionEvidence ? cloneJson(module.promotionEvidence) : undefined,
    examples: (module.examples ?? []).map((example) => cloneJson(example)),
    packageManifest: module.packageManifest ? cloneJson(module.packageManifest) : undefined,
    successCount: module.successCount ?? 0,
    failureCount: module.failureCount ?? 0,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function validateReplacement(input: GeneratedToolReplacementInput, existing: ToolModuleMetadata | undefined): void {
  if (!existing) {
    throw new Error(`Cannot promote replacement for ${input.name}: no installed generated tool exists.`);
  }
  if (existing.source === "builtin") {
    throw new Error(`Cannot promote replacement for ${input.name}: builtin tools cannot be replaced by generated tools.`);
  }
  if (existing.version !== input.replacesVersion) {
    throw new Error(
      `Cannot promote replacement for ${input.name}: installed version ${existing.version} does not match expected ${input.replacesVersion}.`,
    );
  }
  if (input.version === input.replacesVersion) {
    throw new Error(`Cannot promote replacement for ${input.name}: replacement version must differ from ${input.replacesVersion}.`);
  }
}
