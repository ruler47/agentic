import { Tool, ToolHealth, ToolSchema, ToolStartupMode } from "./tool.js";

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
};

export type GeneratedToolReplacementInput = GeneratedToolModuleInput & {
  replacesVersion: string;
};

export type ToolMetadataStore = {
  list(): Promise<ToolModuleMetadata[]>;
  syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]>;
  updateHealth(name: string, health: ToolHealth): Promise<void>;
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
  };
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
