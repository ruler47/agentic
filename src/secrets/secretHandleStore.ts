export type SecretHandleProvider = "env" | "external" | "inline";

export type SecretHandleInput = {
  handle?: string;
  label: string;
  provider: SecretHandleProvider;
  secretRef: string;
  scopes?: string[];
};

export type SecretHandleRecord = {
  handle: string;
  label: string;
  provider: SecretHandleProvider;
  secretRef: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
};

export type SecretHandleStore = {
  create(input: SecretHandleInput): Promise<SecretHandleRecord>;
  get(handle: string): Promise<SecretHandleRecord | undefined>;
  list(limit?: number): Promise<SecretHandleRecord[]>;
  delete(handle: string): Promise<boolean>;
  resolve?(handle: string): Promise<string | undefined>;
};

export class InMemorySecretHandleStore implements SecretHandleStore {
  private readonly handles = new Map<string, SecretHandleRecord>();

  async create(input: SecretHandleInput): Promise<SecretHandleRecord> {
    const normalized = normalizeSecretHandleInput(input);
    const now = new Date().toISOString();
    const record: SecretHandleRecord = {
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    this.handles.set(record.handle, cloneRecord(record));
    return cloneRecord(record);
  }

  async get(handle: string): Promise<SecretHandleRecord | undefined> {
    const record = this.handles.get(handle);
    return record ? cloneRecord(record) : undefined;
  }

  async list(limit = 100): Promise<SecretHandleRecord[]> {
    return [...this.handles.values()]
      .map(cloneRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async delete(handle: string): Promise<boolean> {
    return this.handles.delete(handle);
  }

  async resolve(handle: string): Promise<string | undefined> {
    const record = this.handles.get(handle);
    if (!record) return undefined;
    if (record.provider === "inline") return record.secretRef;
    if (record.provider !== "env") return undefined;
    return process.env[record.secretRef];
  }
}

export function normalizeSecretHandleInput(input: SecretHandleInput): Omit<SecretHandleRecord, "createdAt" | "updatedAt"> {
  const label = normalizeRequiredText(input.label, "label");
  const provider = normalizeProvider(input.provider);
  const secretRef = normalizeSecretRef(input.secretRef, provider);
  const handle = input.handle ? normalizeHandle(input.handle) : `secret.${slugify(label)}`;

  return {
    handle,
    label,
    provider,
    secretRef,
    scopes: normalizeScopes(input.scopes),
  };
}

export function rejectRawSecretPayload(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "value" ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("api_key") ||
      lowerKey.includes("password") ||
      lowerKey.includes("token") ||
      lowerKey.includes("secretvalue")
    ) {
      throw new Error("Raw secret values are not accepted; provide a secretRef such as an environment variable name.");
    }
  }
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeProvider(value: unknown): SecretHandleProvider {
  if (value === "env" || value === "external" || value === "inline") return value;
  throw new Error("provider must be env, external, or inline");
}

function normalizeSecretRef(value: unknown, provider: SecretHandleProvider): string {
  const secretRef = normalizeRequiredText(value, "secretRef");
  if (provider === "env" && !/^[A-Z][A-Z0-9_]{1,127}$/.test(secretRef)) {
    throw new Error("env secretRef must be an environment variable name such as TELEGRAM_BOT_TOKEN");
  }
  if (provider === "external" && /[\r\n]/.test(secretRef)) {
    throw new Error("external secretRef must be a single-line secret manager reference");
  }
  if (provider === "inline" && /[\r\n]/.test(secretRef)) {
    throw new Error("inline secretRef must be a single-line secret value");
  }
  return secretRef;
}

function normalizeHandle(value: string): string {
  const handle = value.trim();
  if (!/^[a-z][a-z0-9._:-]{1,127}$/.test(handle)) {
    throw new Error("handle must be lowercase and may contain letters, numbers, dot, dash, underscore, or colon");
  }
  return handle;
}

function normalizeScopes(value: unknown): string[] {
  if (value === undefined) return ["instance-local"];
  if (!Array.isArray(value)) {
    throw new Error("scopes must be an array");
  }
  return value
    .map((scope) => normalizeRequiredText(scope, "scope"))
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 72) || "handle";
}

function cloneRecord(record: SecretHandleRecord): SecretHandleRecord {
  return {
    ...record,
    scopes: [...record.scopes],
  };
}
