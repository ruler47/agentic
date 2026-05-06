export type ToolRuntimeSettingInput = {
  toolName: string;
  key: string;
  value: string;
};

export type ToolRuntimeSettingRecord = ToolRuntimeSettingInput & {
  updatedAt: string;
};

export type ToolRuntimeSettingsStore = {
  list(toolName?: string): Promise<ToolRuntimeSettingRecord[]>;
  set(input: ToolRuntimeSettingInput): Promise<ToolRuntimeSettingRecord>;
  delete(toolName: string, key: string): Promise<boolean>;
  resolve(toolName: string, key: string): Promise<string | undefined>;
};

export class InMemoryToolRuntimeSettingsStore implements ToolRuntimeSettingsStore {
  private readonly settings = new Map<string, ToolRuntimeSettingRecord>();

  async list(toolName?: string): Promise<ToolRuntimeSettingRecord[]> {
    return [...this.settings.values()]
      .filter((item) => !toolName || item.toolName === toolName)
      .map(cloneSetting)
      .sort((a, b) => a.toolName.localeCompare(b.toolName) || a.key.localeCompare(b.key));
  }

  async set(input: ToolRuntimeSettingInput): Promise<ToolRuntimeSettingRecord> {
    const normalized = normalizeToolRuntimeSettingInput(input);
    const record: ToolRuntimeSettingRecord = {
      ...normalized,
      updatedAt: new Date().toISOString(),
    };
    this.settings.set(settingId(record.toolName, record.key), cloneSetting(record));
    return cloneSetting(record);
  }

  async delete(toolName: string, key: string): Promise<boolean> {
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedKey = normalizeSettingKey(key);
    return this.settings.delete(settingId(normalizedToolName, normalizedKey));
  }

  async resolve(toolName: string, key: string): Promise<string | undefined> {
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedKey = normalizeSettingKey(key);
    return this.settings.get(settingId(normalizedToolName, normalizedKey))?.value;
  }
}

export function normalizeToolRuntimeSettingInput(input: ToolRuntimeSettingInput): ToolRuntimeSettingInput {
  return {
    toolName: normalizeToolName(input.toolName),
    key: normalizeSettingKey(input.key),
    value: normalizeSettingValue(input.value),
  };
}

function normalizeToolName(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error("toolName must be a registry tool name.");
  }
  return normalized;
}

function normalizeSettingKey(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error("setting key must start with a letter and contain only letters, numbers, dot, underscore, colon, or dash.");
  }
  return normalized;
}

function normalizeSettingValue(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("setting value cannot be empty.");
  if (normalized.length > 4096) throw new Error("setting value is too long.");
  return normalized;
}

function settingId(toolName: string, key: string): string {
  return `${toolName}\u0000${key}`;
}

function cloneSetting(record: ToolRuntimeSettingRecord): ToolRuntimeSettingRecord {
  return { ...record };
}
