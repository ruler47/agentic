import { Tool, ToolExample, ToolHealth, ToolSchema, ToolStartupMode, ToolStorageContract } from "./tool.js";

export type ToolModuleSource = "builtin" | "generated";
export type ToolModuleStatus = "available" | "disabled" | "failed";

export type ToolModuleMetadata = {
  name: string;
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
  examples: ToolExample[];
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  updatedAt: string;
};

export type GeneratedToolModuleInput = {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode?: ToolStartupMode;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  modulePath: string;
  testPath?: string;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: ToolExample[];
};

export type GeneratedToolReplacementInput = GeneratedToolModuleInput & {
  replacesVersion: string;
};

export type ToolMetadataStore = {
  list(): Promise<ToolModuleMetadata[]>;
  syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]>;
  updateHealth(name: string, health: ToolHealth): Promise<void>;
  recordUsage(name: string, outcome: "success" | "failure", at?: Date): Promise<void>;
  registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata>;
  promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata>;
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
      .map(cloneModule)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]> {
    const updatedAt = new Date().toISOString();

    for (const tool of tools) {
      const existing = this.modules.get(tool.name);
      this.modules.set(tool.name, {
        name: tool.name,
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
      examples: input.examples ?? existing?.examples ?? [],
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

    return cloneModule(stored);
  }

  async promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata> {
    const existing = this.modules.get(input.name);
    validateReplacement(input, existing);
    if (!existing) {
      throw new Error(`Cannot promote replacement for ${input.name}: no installed generated tool exists.`);
    }

    const stored: ToolModuleMetadata = {
      name: input.name,
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
      examples: input.examples ?? [],
      successCount: existing.successCount,
      failureCount: existing.failureCount,
      lastSuccessAt: existing.lastSuccessAt,
      lastFailureAt: existing.lastFailureAt,
      source: "generated",
      status: "disabled",
      updatedAt: new Date().toISOString(),
    };
    this.modules.set(stored.name, cloneModule(stored));

    return cloneModule(stored);
  }
}

export function toolToMetadata(tool: Tool, updatedAt = new Date().toISOString()): ToolModuleMetadata {
  return {
    name: tool.name,
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
    examples: tool.examples ?? [],
    successCount: 0,
    failureCount: 0,
    source: "builtin",
    status: "available",
    updatedAt,
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
    examples: (module.examples ?? []).map((example) => cloneJson(example)),
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
