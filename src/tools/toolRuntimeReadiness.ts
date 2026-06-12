import type { SecretHandleStore } from "../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../settings/toolRuntimeSettings.js";
import type { ToolModuleMetadata, ToolRuntimeReadiness } from "./toolMetadataStore.js";

export type ToolRuntimeReadinessOptions = {
  runtimeSettings?: ToolRuntimeSettingsStore;
  secretHandles?: SecretHandleStore;
  environment?: Record<string, string | undefined>;
};

export async function resolveToolRuntimeReadiness(
  tool: Pick<ToolModuleMetadata, "name" | "requiredConfigurationKeys" | "requiredSecretHandles">,
  options: ToolRuntimeReadinessOptions = {},
): Promise<ToolRuntimeReadiness> {
  const checkedAt = new Date().toISOString();
  const requiredConfigurationKeys = [...new Set(tool.requiredConfigurationKeys ?? [])];
  const requiredSecretHandles = [...new Set(tool.requiredSecretHandles ?? [])];
  if (requiredConfigurationKeys.length === 0 && requiredSecretHandles.length === 0) {
    return {
      ok: true,
      status: "ready",
      checkedAt,
      missingConfigurationKeys: [],
      missingSecretHandles: [],
      message: "No runtime settings or secret handles are required.",
    };
  }

  if (!options.runtimeSettings && requiredConfigurationKeys.length > 0 && !options.environment) {
    return {
      ok: false,
      status: "unknown",
      checkedAt,
      missingConfigurationKeys: requiredConfigurationKeys,
      missingSecretHandles: [],
      message: "Tool runtime settings store is not configured.",
    };
  }
  if (!options.secretHandles && requiredSecretHandles.length > 0) {
    return {
      ok: false,
      status: "unknown",
      checkedAt,
      missingConfigurationKeys: [],
      missingSecretHandles: requiredSecretHandles,
      message: "Secret handle store is not configured.",
    };
  }

  const missingConfigurationKeys: string[] = [];
  for (const key of requiredConfigurationKeys) {
    const value =
      (await options.runtimeSettings?.resolve(tool.name, key)) ??
      options.environment?.[key];
    if (value === undefined) missingConfigurationKeys.push(key);
  }

  const missingSecretHandles: string[] = [];
  for (const handle of requiredSecretHandles) {
    const value = options.secretHandles?.resolve
      ? await options.secretHandles.resolve(handle)
      : (await options.secretHandles?.get(handle)) ? "__registered__" : undefined;
    if (value === undefined) missingSecretHandles.push(handle);
  }

  if (missingConfigurationKeys.length === 0 && missingSecretHandles.length === 0) {
    return {
      ok: true,
      status: "ready",
      checkedAt,
      missingConfigurationKeys,
      missingSecretHandles,
      message: "All required runtime settings and secret handles are resolvable.",
    };
  }

  const parts = [
    missingConfigurationKeys.length
      ? `configuration ${missingConfigurationKeys.join(", ")}`
      : undefined,
    missingSecretHandles.length
      ? `secret handles ${missingSecretHandles.join(", ")}`
      : undefined,
  ].filter(Boolean);
  return {
    ok: false,
    status: "missing_runtime_requirements",
    checkedAt,
    missingConfigurationKeys,
    missingSecretHandles,
    message: `Missing required runtime values: ${parts.join("; ")}.`,
  };
}
