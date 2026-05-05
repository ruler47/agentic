import { ToolSchema, ToolStartupMode, ToolStorageContract } from "./tool.js";

export type ToolPackageReferenceType =
  | "source-bundle"
  | "oci-image"
  | "external-package"
  | "local-path";

export type ToolPackageReference = {
  type: ToolPackageReferenceType;
  ref: string;
  checksumSha256?: string;
};

export type ToolPackageManifest = {
  schemaVersion: "agentic.tool-package.v1";
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode: ToolStartupMode;
  package: ToolPackageReference;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: unknown[];
  qa?: {
    summary?: string;
    checks?: string[];
    artifacts?: string[];
  };
};

export function normalizeToolPackageManifest(input: unknown): ToolPackageManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool package manifest must be an object.");
  }

  const candidate = input as Record<string, unknown>;
  const manifest: ToolPackageManifest = {
    schemaVersion: parseLiteral(candidate.schemaVersion, "agentic.tool-package.v1", "schemaVersion"),
    name: parseToolName(candidate.name),
    displayName: parseOptionalText(candidate.displayName, "displayName"),
    version: parseVersion(candidate.version),
    description: parseRequiredText(candidate.description, "description"),
    capabilities: parseStringArray(candidate.capabilities, "capabilities"),
    startupMode: parseStartupMode(candidate.startupMode),
    package: parsePackageReference(candidate.package),
    inputSchema: parseOptionalToolSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: parseOptionalToolSchema(candidate.outputSchema, "outputSchema"),
    requiredConfigurationKeys: parseOptionalStringArray(
      candidate.requiredConfigurationKeys,
      "requiredConfigurationKeys",
    ),
    requiredSecretHandles: parseOptionalStringArray(candidate.requiredSecretHandles, "requiredSecretHandles"),
    settingsSchema: parseOptionalToolSchema(candidate.settingsSchema, "settingsSchema"),
    storage: parseOptionalRecord<ToolStorageContract>(candidate.storage, "storage"),
    docsMarkdown: parseOptionalText(candidate.docsMarkdown, "docsMarkdown"),
    examples: Array.isArray(candidate.examples) ? [...candidate.examples] : undefined,
    qa: parseOptionalQa(candidate.qa),
  };

  if (manifest.capabilities.length === 0) {
    throw new Error("Tool package manifest must declare at least one capability.");
  }
  if (manifest.package.type === "oci-image" && !/^[\w./:-]+(@sha256:[a-f0-9]{64})?$/i.test(manifest.package.ref)) {
    throw new Error("OCI image references must be image names, tags, or digests.");
  }

  return manifest;
}

export function serializeToolPackageManifest(manifest: ToolPackageManifest): string {
  return `${JSON.stringify(normalizeToolPackageManifest(manifest), null, 2)}\n`;
}

function parseLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${expected}.`);
  return expected;
}

function parseToolName(value: unknown): string {
  const name = parseRequiredText(value, "name");
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name)) {
    throw new Error("Tool package name must be a stable lowercase tool identifier.");
  }
  return name;
}

function parseVersion(value: unknown): string {
  const version = parseRequiredText(value, "version");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Tool package version must be semantic version-like, for example 1.2.0.");
  }
  return version;
}

function parseStartupMode(value: unknown): ToolStartupMode {
  if (value === "always-on" || value === "on-demand" || value === "ephemeral") return value;
  throw new Error("startupMode must be always-on, on-demand, or ephemeral.");
}

function parsePackageReference(value: unknown): ToolPackageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (
    type !== "source-bundle" &&
    type !== "oci-image" &&
    type !== "external-package" &&
    type !== "local-path"
  ) {
    throw new Error("package.type must be source-bundle, oci-image, external-package, or local-path.");
  }
  return {
    type,
    ref: parseRequiredText(candidate.ref, "package.ref"),
    checksumSha256: parseOptionalText(candidate.checksumSha256, "package.checksumSha256"),
  };
}

function parseOptionalToolSchema(value: unknown, field: string): ToolSchema | undefined {
  return parseOptionalRecord<ToolSchema>(value, field);
}

function parseOptionalRecord<T extends object>(value: unknown, field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as T;
}

function parseOptionalQa(value: unknown): ToolPackageManifest["qa"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("qa must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    summary: parseOptionalText(candidate.summary, "qa.summary"),
    checks: parseOptionalStringArray(candidate.checks, "qa.checks"),
    artifacts: parseOptionalStringArray(candidate.artifacts, "qa.artifacts"),
  };
}

function parseRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function parseOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => parseRequiredText(item, `${field}[${index}]`));
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  return parseStringArray(value, field);
}
