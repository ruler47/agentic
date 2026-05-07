// Heavy parsers for the Tools module group.

import {
  generatedToolInputFromPackageManifest,
  type ToolModulePromotionEvidence,
} from "../../../tools/toolMetadataStore.js";
import { normalizeToolPackageManifest } from "../../../tools/toolPackage.js";
import {
  isRecord,
  parseOptionalPath,
  parseOptionalStringArray,
  parseOptionalText,
  parseOptionalToolSchema,
  parseRequiredPath,
  parseRequiredStringArray,
  parseRequiredText,
  parseStartupMode,
  sanitizeObject,
} from "../../common/parsers.js";

export function parseGeneratedToolModuleInput(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("generated tool module must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const version = typeof candidate.version === "string" ? candidate.version.trim() : "";
  const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
  if (!/^[a-z][a-z0-9.-]{1,80}$/i.test(name)) {
    throw new Error("name must be a stable tool id such as generated.browser.screenshot");
  }
  if (!version) throw new Error("version is required");
  if (!description) throw new Error("description is required");

  return {
    name,
    displayName: parseOptionalText(candidate.displayName),
    version,
    description,
    capabilities: parseRequiredStringArray(candidate.capabilities, "capabilities"),
    startupMode: parseStartupMode(candidate.startupMode),
    inputSchema: parseOptionalToolSchema(candidate.inputSchema, "inputSchema"),
    outputSchema: parseOptionalToolSchema(candidate.outputSchema, "outputSchema"),
    modulePath: parseRequiredPath(candidate.modulePath, "modulePath"),
    testPath: parseOptionalPath(candidate.testPath, "testPath"),
    requiredConfigurationKeys: parseOptionalStringArray(
      candidate.requiredConfigurationKeys,
      "requiredConfigurationKeys",
    ),
    requiredSecretHandles: parseOptionalStringArray(candidate.requiredSecretHandles, "requiredSecretHandles"),
    settingsSchema: parseOptionalToolSchema(candidate.settingsSchema, "settingsSchema"),
    storage: parseOptionalStorageContract(candidate.storage),
    docsMarkdown: parseOptionalText(candidate.docsMarkdown),
    changeSummary: parseOptionalText(candidate.changeSummary),
    promotionEvidence: parseOptionalPromotionEvidence(candidate.promotionEvidence),
    examples: parseOptionalToolExamples(candidate.examples),
    packageManifest:
      candidate.packageManifest === undefined
        ? undefined
        : normalizeToolPackageManifest(candidate.packageManifest),
  };
}

export function parseToolPackageManifestImport(value: unknown) {
  const body =
    value && typeof value === "object" && !Array.isArray(value) && "manifest" in value
      ? (value as Record<string, unknown>).manifest
      : value;
  const manifest = normalizeToolPackageManifest(body);
  return generatedToolInputFromPackageManifest(manifest);
}

export function parseGeneratedToolReplacementInput(expectedName: string, value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("generated tool replacement must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const parsed = parseGeneratedToolModuleInput(value);
  const replacesVersion = typeof candidate.replacesVersion === "string" ? candidate.replacesVersion.trim() : "";
  if (parsed.name !== expectedName) {
    throw new Error(`replacement path name ${expectedName} does not match body name ${parsed.name}`);
  }
  if (!replacesVersion) throw new Error("replacesVersion is required");

  return {
    ...parsed,
    replacesVersion,
  };
}

function parseOptionalPromotionEvidence(value: unknown): ToolModulePromotionEvidence | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotionEvidence must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const status = candidate.status === "promoted" ? "promoted" : undefined;
  const promotedAt = parseOptionalText(candidate.promotedAt);
  const summary = parseOptionalText(candidate.summary);
  if (!status) throw new Error("promotionEvidence.status must be promoted");
  if (!promotedAt) throw new Error("promotionEvidence.promotedAt is required");
  if (!summary) throw new Error("promotionEvidence.summary is required");
  return {
    status: "promoted",
    promotedAt,
    summary,
    buildRequestId: parseOptionalText(candidate.buildRequestId),
    qaReport:
      candidate.qaReport && typeof candidate.qaReport === "object" && !Array.isArray(candidate.qaReport)
        ? (candidate.qaReport as Record<string, unknown>)
        : undefined,
    packageRef: parseOptionalText(candidate.packageRef),
    migrationIds: parseOptionalStringArray(candidate.migrationIds, "promotionEvidence.migrationIds"),
  };
}

function parseOptionalStorageContract(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("storage must be an object");
  }
  const candidate = value as Record<string, unknown>;
  return {
    schema: parseOptionalText(candidate.schema),
    tables: parseOptionalStringArray(candidate.tables, "storage.tables"),
    migrations: parseOptionalStringArray(candidate.migrations, "storage.migrations"),
    retention: parseOptionalText(candidate.retention),
    permissions: parseOptionalStringArray(candidate.permissions, "storage.permissions"),
    destructiveCapabilities: parseOptionalStringArray(
      candidate.destructiveCapabilities,
      "storage.destructiveCapabilities",
    ),
  };
}

function parseOptionalToolExamples(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("examples must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`examples[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      title: parseRequiredText(candidate.title, `examples[${index}].title`),
      input: sanitizeObject(isRecord(candidate.input) ? candidate.input : {}),
      output: candidate.output,
    };
  });
}

export function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function schemaProperty(
  schema: { properties?: Record<string, unknown> } | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const property = schema?.properties?.[key];
  return property && typeof property === "object" && !Array.isArray(property)
    ? (property as Record<string, unknown>)
    : undefined;
}

export function settingPropertyType(property: Record<string, unknown> | undefined): string | undefined {
  const rawType = property?.type;
  return typeof rawType === "string" ? rawType : undefined;
}
