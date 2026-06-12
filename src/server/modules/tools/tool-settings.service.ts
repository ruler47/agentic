import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  normalizeToolRuntimeSettingInput,
  type ToolRuntimeSettingRecord,
  type ToolRuntimeSettingsStore,
} from "../../../settings/toolRuntimeSettings.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import {
  toolToMetadata,
  type ToolMetadataStore,
  type ToolModuleMetadata,
} from "../../../tools/toolMetadataStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  isRecord,
  parseOptionalStringArray,
  parseRequiredText,
} from "../../common/parsers.js";
import {
  TOOL_METADATA_STORE,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
} from "../../persistence/tokens.js";
import { looksLikeUrl, schemaProperty, settingPropertyType } from "./tool-parsers.js";

@Injectable()
export class ToolSettingsService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS) private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listSettings(toolName?: string): Promise<ToolRuntimeSettingRecord[]> {
    return this.runtimeSettings ? this.runtimeSettings.list(toolName) : [];
  }

  async setSetting(rawBody: unknown): Promise<ToolRuntimeSettingRecord> {
    if (!this.runtimeSettings) {
      throw new ServiceUnavailableException("Tool runtime settings store is not configured");
    }
    if (!isRecord(rawBody)) throw new BadRequestException("tool setting must be an object");
    let input: { toolName: string; key: string; value: string };
    try {
      input = normalizeToolRuntimeSettingInput({
        toolName: parseRequiredText(rawBody.toolName, "toolName"),
        key: parseRequiredText(rawBody.key, "key"),
        value: parseRequiredText(rawBody.value, "value"),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool runtime setting request",
      );
    }
    const metadata = await this.findToolMetadata(input.toolName);
    const issues = this.validateToolSettingValue(metadata, input.key, input.value);
    if (issues.length > 0) {
      throw new BadRequestException(issues[0]);
    }
    const setting = await this.runtimeSettings.set(input);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.setting_updated",
      targetType: "tool",
      targetId: setting.toolName,
      status: "success",
      summary: `Updated runtime setting ${setting.key} for ${setting.toolName}`,
      metadata: { key: setting.key },
    });
    return setting;
  }

  async deleteSetting(toolName: string, key: string): Promise<{ deleted: true; toolName: string; key: string }> {
    if (!this.runtimeSettings) {
      throw new ServiceUnavailableException("Tool runtime settings store is not configured");
    }
    const deleted = await this.runtimeSettings.delete(toolName, key);
    if (!deleted) throw new NotFoundException("Tool runtime setting was not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.setting_deleted",
      targetType: "tool",
      targetId: toolName,
      status: "success",
      summary: `Deleted runtime setting ${key} for ${toolName}`,
      metadata: { key },
    });
    return { deleted: true, toolName, key };
  }

  async validateSettings(rawBody: unknown) {
    if (!this.runtimeSettings) {
      throw new ServiceUnavailableException("Tool runtime settings store is not configured");
    }
    try {
      if (!isRecord(rawBody)) throw new Error("tool settings validation request must be an object");
      const toolName = normalizeToolRuntimeSettingInput({
        toolName: parseRequiredText(rawBody.toolName, "toolName"),
        key: "DUMMY_KEY",
        value: "dummy",
      }).toolName;
      const requestedSettings = this.parseRuntimeSettingsMap(rawBody.settings);
      const deleteKeys = parseOptionalStringArray(rawBody.deleteKeys, "deleteKeys") ?? [];
      const metadata = await this.findToolMetadata(toolName);
      const existing = new Map(
        (await this.runtimeSettings.list(toolName)).map((item) => [item.key, item.value]),
      );
      for (const key of deleteKeys) {
        const normalized = normalizeToolRuntimeSettingInput({ toolName, key, value: "dummy" });
        existing.delete(normalized.key);
      }
      for (const [key, settingValue] of Object.entries(requestedSettings)) {
        const normalized = normalizeToolRuntimeSettingInput({ toolName, key, value: settingValue });
        existing.set(normalized.key, normalized.value);
      }

      const issues: string[] = [];
      const warnings: string[] = [];
      if (!metadata) {
        warnings.push(`No tool metadata found for ${toolName}; only key/value shape was validated.`);
      }
      const requiredKeys = new Set(metadata?.requiredConfigurationKeys ?? []);
      const schemaProperties = metadata?.settingsSchema?.properties ?? {};
      for (const key of requiredKeys) {
        if (!existing.has(key)) issues.push(`${key} is required by ${toolName}.`);
      }
      for (const [key, settingValue] of existing.entries()) {
        issues.push(...this.validateToolSettingValue(metadata, key, settingValue));
        if (metadata && !requiredKeys.has(key) && !Object.prototype.hasOwnProperty.call(schemaProperties, key)) {
          warnings.push(
            `${key} is not declared by ${toolName}; it will be treated as an optional runtime override.`,
          );
        }
      }
      const previewKeys = new Set([
        ...requiredKeys,
        ...Object.keys(schemaProperties),
        ...existing.keys(),
      ]);
      const preview = [...previewKeys].sort((a, b) => a.localeCompare(b)).map((key) => {
        const property = schemaProperty(metadata?.settingsSchema, key);
        return {
          key,
          configured: existing.has(key),
          required: requiredKeys.has(key),
          declared: Boolean(property),
          type: settingPropertyType(property),
        };
      });
      return { ok: issues.length === 0, toolName, issues, warnings, preview };
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool runtime setting validation request",
      );
    }
  }

  private async findToolMetadata(toolName: string): Promise<ToolModuleMetadata | undefined> {
    if (this.metadata) {
      return (await this.metadata.list()).find((tool) => tool.name === toolName);
    }
    return (this.registry?.list() ?? [])
      .map((tool) => toolToMetadata(tool))
      .find((tool) => tool.name === toolName);
  }

  private parseRuntimeSettingsMap(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new Error("settings must be an object");
    const parsed: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(value)) {
      if (typeof rawValue !== "string") throw new Error(`settings.${key} must be a string`);
      if (rawValue.trim() === "") continue;
      parsed[key] = rawValue;
    }
    return parsed;
  }

  private validateToolSettingValue(
    metadata: ToolModuleMetadata | undefined,
    key: string,
    value: string,
  ): string[] {
    const property = schemaProperty(metadata?.settingsSchema, key);
    if (!property) return [];
    const issues: string[] = [];
    const type = settingPropertyType(property);
    if (Array.isArray(property.enum) && !property.enum.map(String).includes(value)) {
      issues.push(`${key} must be one of: ${property.enum.map(String).join(", ")}.`);
    }
    if (type === "boolean" && !/^(true|false|1|0|yes|no|on|off)$/i.test(value)) {
      issues.push(`${key} must be a boolean value.`);
    }
    if (type === "number" || type === "integer") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        issues.push(`${key} must be a number.`);
      } else {
        if (type === "integer" && !Number.isInteger(parsed)) issues.push(`${key} must be an integer.`);
        if (typeof property.minimum === "number" && parsed < property.minimum) {
          issues.push(`${key} must be at least ${property.minimum}.`);
        }
        if (typeof property.maximum === "number" && parsed > property.maximum) {
          issues.push(`${key} must be at most ${property.maximum}.`);
        }
      }
    }
    if (type === "string" || !type) {
      if (typeof property.minLength === "number" && value.length < property.minLength) {
        issues.push(`${key} must be at least ${property.minLength} characters.`);
      }
      if (typeof property.maxLength === "number" && value.length > property.maxLength) {
        issues.push(`${key} must be at most ${property.maxLength} characters.`);
      }
      if (typeof property.pattern === "string") {
        try {
          if (!new RegExp(property.pattern).test(value)) issues.push(`${key} does not match its required pattern.`);
        } catch {
          issues.push(`${key} has an invalid schema pattern.`);
        }
      }
      if ((property.format === "uri" || property.format === "url") && !looksLikeUrl(value)) {
        issues.push(`${key} must be a valid URL.`);
      }
    }
    return issues;
  }
}
