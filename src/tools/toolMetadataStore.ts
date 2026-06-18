import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Tool, ToolExample, ToolHealth, ToolSchema, ToolStartupMode, ToolStorageContract } from "./tool.js";
import type { ToolPackageManifest } from "./toolPackage.js";

export type ToolModuleSource = "builtin" | "generated";
/**
 * Phase 18: 4-state lifecycle for a tool module / version.
 *
 *   - `disabled` — initial state right after `registerGenerated` /
 *     `promoteReplacement`. The row exists but the loader hasn't
 *     run yet (or the operator deactivated it).
 *   - `loaded` — the package runner imported the source bundle
 *     successfully. The tool's code parses, the entrypoint is
 *     present. This says nothing about runtime correctness — only
 *     that the module can be imported. Set by `updateHealth(ok=true)`.
 *   - `available` — a QA pass (council or explicit operator "Mark
 *     available") confirmed the tool actually works. Set by
 *     `markAvailable`. STRONGER than `loaded`.
 *   - `failed` — a hard failure signal. Loader threw, council QA
 *     gave up, or operator explicitly marked broken. Set by
 *     `updateHealth(ok=false)` and Slice F rollback paths.
 *
 * Runtime treats only `available` as callable by agents. `loaded`
 * means the package can be imported and manually tested, but still
 * needs explicit operator promotion before it is offered to agents.
 */
export type ToolModuleStatus = "available" | "loaded" | "disabled" | "failed";

export type ToolModulePromotionEvidence = {
  status: "promoted";
  promotedAt: string;
  summary: string;
  buildRequestId?: string;
  qaReport?: Record<string, unknown>;
  packageRef?: string;
  migrationIds?: string[];
};

export type ToolVersionLifecycleEvent = {
  id: string;
  type:
    | "created"
    | "manual_run"
    | "marked_available"
    | "activated"
    | "agent_accepted"
    | "rejected"
    | "deleted";
  status: "success" | "failure" | "info";
  summary: string;
  actorId?: string;
  actorType?: string;
  runId?: string;
  traceRunId?: string;
  auditEventId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
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
  manualRunEvidence?: {
    successCount: number;
    failureCount: number;
    latestSuccess?: {
      auditEventId: string;
      ranAt: string;
      durationMs?: number;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    latestFailure?: {
      auditEventId: string;
      ranAt: string;
      durationMs?: number;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    requiredForActivation: boolean;
  };
  runScopedCandidateEvidence?: {
    successCount: number;
    failureCount: number;
    latestSuccess?: {
      runId: string;
      ranAt: string;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    latestFailure?: {
      runId: string;
      ranAt: string;
      inputPreview?: unknown;
      contentPreview?: string;
    };
    requiredForActivation: boolean;
  };
  reviewStatus?: "candidate" | "accepted" | "rejected";
  lifecycleEvents?: ToolVersionLifecycleEvent[];
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
  runtimeReadiness?: ToolRuntimeReadiness;
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

export type ToolRuntimeReadiness = {
  ok: boolean;
  status: "ready" | "missing_runtime_requirements" | "unknown";
  checkedAt: string;
  missingConfigurationKeys: string[];
  missingSecretHandles: string[];
  message: string;
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

const OPERATOR_DISABLED_HEALTH_DETAIL = "Operator disabled tool.";

export type ToolMetadataStore = {
  list(): Promise<ToolModuleMetadata[]>;
  listVersions(name: string): Promise<ToolModuleVersionSummary[]>;
  syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]>;
  updateHealth(name: string, health: ToolHealth): Promise<void>;
  recordUsage(name: string, outcome: "success" | "failure", at?: Date): Promise<void>;
  setStatus(name: string, status: Extract<ToolModuleStatus, "available" | "disabled">): Promise<ToolModuleMetadata | undefined>;
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
  /**
   * Phase 16 Slice I: drop a single non-active version from the
   * version history. Returns true if the row was deleted, false if
   * the version was not found OR if the caller asked to delete the
   * currently-active version (refused — operator must
   * `activateVersion` something else first to avoid orphaning the
   * tool). Throws for builtins.
   */
  deleteVersion(name: string, version: string): Promise<boolean>;
  deleteGenerated(name: string): Promise<boolean>;
};

export class InMemoryToolMetadataStore implements ToolMetadataStore {
  private readonly modules = new Map<string, ToolModuleMetadata>();
  private readonly moduleVersions = new Map<string, Map<string, ToolModuleMetadata>>();

  constructor(initialModules: ToolModuleMetadata[] = []) {
    for (const item of initialModules) {
      const activeVersion = item.versions?.find((version) => version.active)?.version ?? item.version;
      this.setActiveVersion(cloneModule({ ...item, version: activeVersion }));
      for (const version of item.versions ?? []) {
        const versionModule = moduleFromVersionSummary(item, version);
        if (version.active || version.version === activeVersion) this.setActiveVersion(versionModule);
        else this.setInactiveVersion(versionModule);
      }
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
    const desired = new Set(tools.map((tool) => tool.name));

    for (const [name, existing] of this.modules.entries()) {
      if (existing.source === "builtin" && !desired.has(name)) {
        this.modules.delete(name);
      }
    }

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

    // Phase 18: load-time health probe is a STATIC check ("entrypoint
    // imports") — it does not say the tool actually works. Status
    // semantics:
    //   - ok=true  → upgrade `disabled` to `loaded`. Preserve
    //                `available` (the row was already blessed via
    //                `markAvailable`) — we never downgrade green.
    //   - ok=false → hard failure, flip to `failed` regardless of
    //                prior state. The operator needs to see it.
    let nextStatus: ToolModuleStatus;
    if (health.ok) {
      nextStatus = existing.status === "available"
        ? "available"
        : isOperatorDisabled(existing)
          ? "disabled"
          : "loaded";
    } else {
      nextStatus = "failed";
    }
    const updated = {
      ...existing,
      status: nextStatus,
      lastHealthOk: health.ok,
      lastHealthDetail: nextStatus === "disabled" && isOperatorDisabled(existing)
        ? `${OPERATOR_DISABLED_HEALTH_DETAIL} Last health: ${health.detail}`
        : health.detail,
      updatedAt: new Date().toISOString(),
    };
    this.setActiveVersion(updated);
  }

  async recordUsage(name: string, outcome: "success" | "failure", at = new Date()): Promise<void> {
    const existing = this.modules.get(name);
    if (!existing) return;

    const timestamp = at.toISOString();
    const updated = {
      ...existing,
      successCount: existing.successCount + (outcome === "success" ? 1 : 0),
      failureCount: existing.failureCount + (outcome === "failure" ? 1 : 0),
      lastSuccessAt: outcome === "success" ? timestamp : existing.lastSuccessAt,
      lastFailureAt: outcome === "failure" ? timestamp : existing.lastFailureAt,
      updatedAt: timestamp,
    };
    this.setActiveVersion(updated);
  }

  async setStatus(
    name: string,
    status: Extract<ToolModuleStatus, "available" | "disabled">,
  ): Promise<ToolModuleMetadata | undefined> {
    const existing = this.modules.get(name);
    if (!existing) return undefined;
    const updated: ToolModuleMetadata = {
      ...cloneModule(existing),
      status,
      lastHealthDetail: status === "disabled" ? OPERATOR_DISABLED_HEALTH_DETAIL : existing.lastHealthDetail,
      updatedAt: new Date().toISOString(),
    };
    this.setActiveVersion(updated);
    return { ...cloneModule(updated), versions: this.versionsFor(name, updated.version) };
  }

  async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(input.name);
    if (existing?.source === "builtin") {
      throw new Error(`Cannot register generated tool ${input.name}: a builtin tool already uses that name.`);
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
      status: existing && existing.version !== input.version ? "disabled" : existing?.status ?? "disabled",
      lastHealthOk: existing?.lastHealthOk,
      lastHealthDetail: existing?.lastHealthDetail,
      updatedAt: new Date().toISOString(),
    };
    if (existing && existing.version !== input.version) {
      this.setInactiveVersion(stored);
      return { ...cloneModule(existing), versions: this.versionsFor(existing.name, existing.version) };
    }

    this.setActiveVersion(stored);

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
    this.setActiveVersion(stored);

    return { ...cloneModule(stored), versions: this.versionsFor(stored.name, stored.version) };
  }

  async activateVersion(name: string, version: string): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(name);
    if (!existing) throw new Error(`Generated tool ${name} was not found.`);
    if (existing.source === "builtin") throw new Error(`Cannot switch builtin tool ${name}.`);
    const selected = this.moduleVersions.get(name)?.get(version);
    if (!selected) throw new Error(`Version ${version} for ${name} was not found.`);
    this.setActiveVersion(selected);
    const active = this.modules.get(name)!;
    return { ...cloneModule(active), versions: this.versionsFor(name, active.version) };
  }

  async markAvailable(name: string, version: string): Promise<void> {
    const existing = this.modules.get(name);
    if (!existing) return;
    if (existing.source === "builtin") return;
    const target = this.moduleVersions.get(name)?.get(version);
    if (!target) return;
    const updated: ToolModuleMetadata = {
      ...cloneModule(target),
      status: "available",
      updatedAt: new Date().toISOString(),
    };
    if (existing.version === version) this.setActiveVersion(updated);
    else this.setInactiveVersion(updated);
  }

  async deleteVersion(name: string, version: string): Promise<boolean> {
    const existing = this.modules.get(name);
    if (!existing) return false;
    if (existing.source === "builtin") {
      throw new Error(`Cannot delete builtin tool ${name}.`);
    }
    if (existing.version === version) {
      // Cannot delete the active version — operator must activate
      // another version first. The Postgres impl enforces the same
      // invariant; we keep it consistent here.
      return false;
    }
    return this.moduleVersions.get(name)?.delete(version) ?? false;
  }

  async deleteGenerated(name: string): Promise<boolean> {
    const existing = this.modules.get(name);
    if (!existing) return false;
    if (existing.source === "builtin") {
      throw new Error(`Cannot delete builtin tool ${name}.`);
    }
    this.moduleVersions.delete(name);
    return this.modules.delete(name);
  }

  private versionsFor(name: string, activeVersion: string): ToolModuleVersionSummary[] {
    const versions = this.moduleVersions.get(name);
    const active = this.modules.get(name);
    if (!versions || !active) return [];
    return [...versions.values()]
      .map((module) => ({
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
      }))
      .sort((a, b) => compareVersionsDesc(a.version, b.version) || b.updatedAt.localeCompare(a.updatedAt));
  }

  private setActiveVersion(module: ToolModuleMetadata): void {
    const stored = cloneModule(module);
    this.modules.set(stored.name, stored);
    const versions = this.moduleVersions.get(stored.name) ?? new Map<string, ToolModuleMetadata>();
    versions.set(stored.version, cloneModule(stored));
    this.moduleVersions.set(stored.name, versions);
  }

  private setInactiveVersion(module: ToolModuleMetadata): void {
    const stored = cloneModule(module);
    const versions = this.moduleVersions.get(stored.name) ?? new Map<string, ToolModuleMetadata>();
    versions.set(stored.version, stored);
    this.moduleVersions.set(stored.name, versions);
  }
}

function isOperatorDisabled(module: ToolModuleMetadata): boolean {
  return module.status === "disabled" && (module.lastHealthDetail ?? "").startsWith(OPERATOR_DISABLED_HEALTH_DETAIL);
}

export class LocalJsonToolMetadataStore extends InMemoryToolMetadataStore {
  constructor(private readonly filePath: string) {
    super(readLocalToolMetadata(filePath));
  }

  override async syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]> {
    const result = await super.syncBuiltins(tools);
    await this.persist();
    return result;
  }

  override async updateHealth(name: string, health: ToolHealth): Promise<void> {
    await super.updateHealth(name, health);
    await this.persist();
  }

  override async recordUsage(name: string, outcome: "success" | "failure", at?: Date): Promise<void> {
    await super.recordUsage(name, outcome, at);
    await this.persist();
  }

  override async setStatus(
    name: string,
    status: Extract<ToolModuleStatus, "available" | "disabled">,
  ): Promise<ToolModuleMetadata | undefined> {
    const result = await super.setStatus(name, status);
    await this.persist();
    return result;
  }

  override async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    const result = await super.registerGenerated(input);
    await this.persist();
    return result;
  }

  override async promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata> {
    const result = await super.promoteReplacement(input);
    await this.persist();
    return result;
  }

  override async activateVersion(name: string, version: string): Promise<ToolModuleMetadata> {
    const result = await super.activateVersion(name, version);
    await this.persist();
    return result;
  }

  override async markAvailable(name: string, version: string): Promise<void> {
    await super.markAvailable(name, version);
    await this.persist();
  }

  override async deleteVersion(name: string, version: string): Promise<boolean> {
    const result = await super.deleteVersion(name, version);
    if (result) await this.persist();
    return result;
  }

  override async deleteGenerated(name: string): Promise<boolean> {
    const result = await super.deleteGenerated(name);
    if (result) await this.persist();
    return result;
  }

  private async persist(): Promise<void> {
    const modules = await this.list();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ modules }, null, 2)}\n`, "utf8");
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

function readLocalToolMetadata(filePath: string): ToolModuleMetadata[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { modules?: unknown };
    return Array.isArray(parsed.modules)
      ? parsed.modules.filter(isToolModuleMetadataLike) as ToolModuleMetadata[]
      : [];
  } catch {
    return [];
  }
}

function isToolModuleMetadataLike(value: unknown): value is ToolModuleMetadata {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { version?: unknown }).version === "string"
    && typeof (value as { description?: unknown }).description === "string"
    && Array.isArray((value as { capabilities?: unknown }).capabilities)
    && ((value as { source?: unknown }).source === "builtin" || (value as { source?: unknown }).source === "generated")
    && typeof (value as { status?: unknown }).status === "string",
  );
}

function moduleFromVersionSummary(
  base: ToolModuleMetadata,
  version: ToolModuleVersionSummary,
): ToolModuleMetadata {
  return {
    ...cloneModule(base),
    version: version.version,
    displayName: version.displayName ?? base.displayName,
    description: version.description ?? base.description,
    capabilities: [...(version.capabilities ?? base.capabilities)],
    modulePath: version.modulePath ?? base.modulePath,
    testPath: version.testPath ?? base.testPath,
    requiredSecretHandles: [...(version.requiredSecretHandles ?? base.requiredSecretHandles ?? [])],
    changeSummary: version.changeSummary ?? base.changeSummary,
    promotionEvidence: version.promotionEvidence ? cloneJson(version.promotionEvidence) : base.promotionEvidence,
    packageManifest: version.packageManifest ? cloneJson(version.packageManifest) : base.packageManifest,
    lastHealthDetail: version.lastHealthDetail ?? base.lastHealthDetail,
    successCount: version.successCount ?? base.successCount,
    failureCount: version.failureCount ?? base.failureCount,
    status: version.status,
    updatedAt: version.updatedAt,
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
    runtimeReadiness: module.runtimeReadiness ? cloneJson(module.runtimeReadiness) : undefined,
    successCount: module.successCount ?? 0,
    failureCount: module.failureCount ?? 0,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
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
