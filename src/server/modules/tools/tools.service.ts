import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ToolRegistry } from "../../../tools/registry.js";
import {
  toolToMetadata,
  type ToolMetadataStore,
  type ToolModuleMetadata,
} from "../../../tools/toolMetadataStore.js";
import {
  normalizeToolRuntimeSettingInput,
  type ToolRuntimeSettingRecord,
  type ToolRuntimeSettingsStore,
} from "../../../settings/toolRuntimeSettings.js";
import type { ToolPackageRunner } from "../../../tools/toolPackageRunner.js";
import type { ToolModuleVersionSummary } from "../../../tools/toolMetadataStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  parseRequiredText,
  isRecord,
  parseOptionalStringArray,
} from "../../common/parsers.js";
import {
  RELOAD_GENERATED_TOOLS,
  TOOL_METADATA_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
} from "../../persistence/tokens.js";
import {
  looksLikeUrl,
  parseGeneratedToolModuleInput,
  parseGeneratedToolReplacementInput,
  parseToolPackageManifestImport,
  schemaProperty,
  settingPropertyType,
} from "./tool-parsers.js";

@Injectable()
export class ToolsService {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS) private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly packageRunners: ToolPackageRunner[] | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reload: (() => Promise<void>) | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listTools(): Promise<ToolModuleMetadata[]> {
    const tools = this.registry?.list() ?? [];
    if (this.metadata) return this.metadata.list();
    return tools.map((tool) => toolToMetadata(tool));
  }

  async toolHealth(): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    const tools = this.registry?.list() ?? [];
    return Promise.all(
      tools.map(async (tool) => {
        const result = tool.healthcheck
          ? await tool.healthcheck()
          : { ok: true, detail: "No healthcheck registered." };
        await this.metadata?.updateHealth(tool.name, result);
        return { name: tool.name, ...result };
      }),
    );
  }

  /**
   * Phase 13 follow-up: manual tool invocation from the UI / curl.
   * Lets the operator paste an input payload, click "Run", and see
   * the exact `ToolResult` the runtime would hand back to an agent.
   * Useful for:
   *   1. Smoke-testing a freshly-built / freshly-rebuilt tool service
   *      without having to craft a whole agent run.
   *   2. Verifying that a tool version actually works before promoting
   *      it.
   *   3. Reproducing an agent-observed failure with a known-good
   *      input.
   *
   * Runs synchronously, returns whatever the tool returned (or the
   * structured failure). Audits the invocation so the timeline shows
   * who tried what.
   */
  async runToolManually(
    name: string,
    body: unknown,
    actor: { actorId: string } = { actorId: "user-admin" },
  ): Promise<{
    tool: { name: string; version: string };
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
  }> {
    if (!this.registry) throw new ServiceUnavailableException("Tool registry is not configured");
    const tool = this.registry.get(name);
    if (!tool) throw new NotFoundException(`Tool not registered: ${name}`);

    const input = isRecord(body) && isRecord((body as Record<string, unknown>).input)
      ? ((body as Record<string, unknown>).input as Record<string, unknown>)
      : isRecord(body)
        ? (body as Record<string, unknown>)
        : {};

    const startedAt = Date.now();
    let result: { ok: boolean; content: string; data?: unknown };
    try {
      result = await tool.run(input, {
        toolName: tool.name,
        now: new Date(),
        caller: "manual-ui",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = { ok: false, content: `Manual tool invocation threw: ${detail}` };
    }
    const durationMs = Date.now() - startedAt;

    await this.audit.record({
      instanceId: "instance-local",
      actorId: actor.actorId,
      actorType: "user",
      action: "tool.manual_run",
      targetType: "tool",
      targetId: tool.name,
      status: result.ok ? "success" : "failure",
      summary: `Manual tool run: ${tool.name} (${result.ok ? "ok" : "failed"}, ${durationMs}ms)`,
      metadata: {
        inputKeys: Object.keys(input),
        contentPreview: (result.content ?? "").slice(0, 200),
      },
    });

    // Phase 13 follow-up: HttpToolAdapter rehydrates artifact
    // `contentBase64` → Node `Buffer` in `result.data` so downstream
    // helpers (saveArtifact, etc.) get usable binary. But the
    // /api/tools/:name/run response is plain JSON, where Buffer serializes
    // to `{ type: "Buffer", data: [...] }` and the UI sees an object
    // instead of file bytes. Re-serialize Buffer back to `contentBase64`
    // here so the Manual Run panel can render a Download link.
    const wireResult = {
      ok: result.ok,
      content: typeof result.content === "string" ? result.content : "",
      data: serializeBuffersForWire(result.data),
    };

    return {
      tool: { name: tool.name, version: tool.version ?? "unknown" },
      result: wireResult,
      durationMs,
    };
  }

  async reloadGenerated(): Promise<{ tools: ToolModuleMetadata[] }> {
    if (!this.reload) {
      throw new ServiceUnavailableException("Generated tool reload is not configured");
    }
    try {
      await this.reload();
    } catch (error) {
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : "Generated tool reload failed",
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.generated_reload",
      targetType: "tool_registry",
      targetId: "generated-tools",
      status: "success",
      summary: "Generated tools reloaded by operator.",
    });
    return { tools: this.metadata ? await this.metadata.list() : [] };
  }

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

  async listPackageRunners() {
    return (this.packageRunners ?? []).map((runner) =>
      runner.describe
        ? runner.describe()
        : {
            name: `${runner.type} runner`,
            type: runner.type,
            status: "available",
            detail: "Runner does not expose extended diagnostics.",
            supportedPackageTypes: runner.type === "legacy-local-path" ? [] : [runner.type],
          },
    );
  }

  async registerGenerated(rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseGeneratedToolModuleInput(rawBody);
      return await this.metadata.registerGenerated(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool module",
      );
    }
  }

  async importPackageManifest(rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseToolPackageManifestImport(rawBody);
      const registered = await this.metadata.registerGenerated(input);
      await this.reload?.();
      const tool = (await this.metadata.list()).find((candidate) => candidate.name === registered.name) ?? registered;
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.package_imported",
        targetType: "tool",
        targetId: tool.name,
        status: "success",
        summary: `Imported tool package manifest: ${tool.name}@${tool.version}`,
      });
      return tool;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool package manifest",
      );
    }
  }

  async listVersions(name: string): Promise<ToolModuleVersionSummary[]> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      return await this.metadata.listVersions(name);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool version request",
      );
    }
  }

  /**
   * Phase 13 — derive per-tool usage stats from the metadata store.
   * The store already accumulates successCount / failureCount /
   * lastSuccessAt / lastFailureAt; this method shapes them into a
   * single structured response with derived metrics (success rate,
   * total runs, per-version aggregates) so the UI doesn't need to
   * compute ratios on every render.
   */
  async getToolStats(name: string): Promise<{
    name: string;
    activeVersion: string;
    totalRuns: number;
    successCount: number;
    failureCount: number;
    successRate: number | null;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    versions: Array<{
      version: string;
      activatedAt?: string;
      changeSummary?: string;
    }>;
  }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const tool = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!tool) throw new NotFoundException("Tool not found");
    const totalRuns = tool.successCount + tool.failureCount;
    const successRate = totalRuns > 0 ? tool.successCount / totalRuns : null;
    const versions = await this.metadata.listVersions(name);
    return {
      name: tool.name,
      activeVersion: tool.version,
      totalRuns,
      successCount: tool.successCount,
      failureCount: tool.failureCount,
      successRate,
      lastSuccessAt: tool.lastSuccessAt,
      lastFailureAt: tool.lastFailureAt,
      versions: versions.map((v) => ({
        version: v.version,
        activatedAt: v.updatedAt,
        changeSummary: v.changeSummary,
      })),
    };
  }

  /**
   * Phase 13 — return the package manifest as a JSON download. Used
   * by the export UI to share a tool's blueprint with another
   * agentic instance. Operators can then POST the same JSON back
   * via /api/tools/package-manifests on the target instance to
   * import the tool blueprint (the OCI image lives in the local
   * Docker daemon and is published / pulled separately).
   */
  async exportPackageManifest(name: string): Promise<{
    manifest: unknown;
    filename: string;
  }> {
    const manifest = await this.getPackageManifest(name);
    const safeName = name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
    return {
      manifest,
      filename: `${safeName}-${
        (manifest as { version?: string })?.version ?? "version"
      }.tool-package.json`,
    };
  }

  async getPackageManifest(name: string) {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    const tool = (await this.metadata.list()).find((candidate) => candidate.name === name);
    if (!tool) throw new NotFoundException("Generated tool was not found");
    if (!tool.packageManifest) {
      throw new NotFoundException("Generated tool does not have a package manifest");
    }
    return tool.packageManifest;
  }

  async deleteGenerated(name: string): Promise<{ deleted: true; name: string }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    let deleted: boolean;
    try {
      deleted = await this.metadata.deleteGenerated(name);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool delete request",
      );
    }
    if (!deleted) throw new NotFoundException("Generated tool was not found");
    this.registry?.unregister?.(name);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.deleted",
      targetType: "tool",
      targetId: name,
      status: "success",
      summary: `Generated tool deleted: ${name}`,
    });
    return { deleted: true, name };
  }

  /**
   * Phase 16 Slice I: drop a single non-active version from the
   * version history. The metadata store refuses to delete the
   * currently-active row, so a 400 here means "activate something
   * else first". The active version stays untouched in
   * tool_modules; only the historical row in
   * tool_module_versions is removed.
   */
  async deleteVersion(
    name: string,
    version: string,
  ): Promise<{ deleted: true; name: string; version: string }> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    let deleted: boolean;
    try {
      deleted = await this.metadata.deleteVersion(name, version);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid version delete request",
      );
    }
    if (!deleted) {
      throw new BadRequestException(
        `Cannot delete v${version} of ${name}: it is either the currently active version (activate another version first) or it is not on record.`,
      );
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool.deleted",
      targetType: "tool",
      targetId: `${name}@${version}`,
      status: "success",
      summary: `Generated tool version deleted: ${name} v${version}`,
    });
    return { deleted: true, name, version };
  }

  async promoteReplacement(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      const input = parseGeneratedToolReplacementInput(name, rawBody);
      return await this.metadata.promoteReplacement(input);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool replacement",
      );
    }
  }

  async activateVersion(name: string, rawBody: unknown): Promise<ToolModuleMetadata> {
    if (!this.metadata) {
      throw new ServiceUnavailableException("Tool metadata store is not configured");
    }
    try {
      if (!isRecord(rawBody)) throw new Error("activate version request must be an object");
      const version = parseRequiredText(rawBody.version, "version");
      const tool = await this.metadata.activateVersion(name, version);
      await this.reload?.();
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "tool.version_activated",
        targetType: "tool",
        targetId: name,
        status: "success",
        summary: `Activated ${name} ${version}`,
      });
      return tool;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid generated tool version activation",
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

/**
 * Phase 13 follow-up: walk a tool result and re-encode any Node `Buffer`
 * we find back into the wire-friendly `contentBase64` shape (with the
 * sibling `content` key removed). HttpToolAdapter rehydrates docker
 * services' base64 payloads into Buffers so the in-process saveArtifact
 * path gets binary; for the Manual Run JSON response we need to reverse
 * that so the UI's artifact detector sees a usable file. Pure function;
 * cycle-safe via the `seen` set.
 */
function serializeBuffersForWire(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return { contentBase64: value.toString("base64") };
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => serializeBuffersForWire(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "content" && Buffer.isBuffer(nested)) {
      out.contentBase64 = (nested as Buffer).toString("base64");
      continue;
    }
    out[key] = serializeBuffersForWire(nested, seen);
  }
  return out;
}
