import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { TOOL_MIGRATION_STORE } from "../../persistence/tokens.js";
import type { ToolMigrationStatus, ToolMigrationStore } from "../../../tools/toolMigrationStore.js";
import { ToolManualRunService } from "./tool-manual-run.service.js";
import { ToolRegistryAdminService } from "./tool-registry-admin.service.js";
import { ToolSettingsService } from "./tool-settings.service.js";
import { ToolVersionLifecycleService } from "./tool-version-lifecycle.service.js";
import { ToolsService } from "./tools.service.js";

@Controller("api")
export class ToolsController {
  constructor(
    @Inject(ToolsService) private readonly tools: ToolsService,
    @Inject(ToolManualRunService) private readonly manualRuns: ToolManualRunService,
    @Inject(ToolRegistryAdminService) private readonly toolAdmin: ToolRegistryAdminService,
    @Inject(ToolSettingsService) private readonly toolSettings: ToolSettingsService,
    @Inject(ToolVersionLifecycleService) private readonly toolVersions: ToolVersionLifecycleService,
    @Inject(TOOL_MIGRATION_STORE) private readonly toolMigrations: ToolMigrationStore,
  ) {}

  @Get("tools")
  async list() {
    return { tools: await this.toolAdmin.listTools() };
  }

  @Get("tools/health")
  async health() {
    return { tools: await this.toolAdmin.toolHealth() };
  }

  @Post("tools/reload-generated")
  async reload() {
    return this.toolAdmin.reloadGenerated();
  }

  @Post("tools/create-package")
  @HttpCode(201)
  async createPackage(@Body() body: unknown) {
    return this.tools.createToolPackage(body);
  }

  @Get("tool-creations")
  async listCreations(
    @Query("toolName") toolName?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      creations: await this.tools.listToolCreations({
        toolName,
        status,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Get("tool-creations/:id")
  async getCreation(@Param("id") id: string) {
    return { creation: await this.tools.getToolCreation(decodeURIComponent(id)) };
  }

  @Get("tool-migrations")
  async listMigrations(
    @Query("toolName") toolName?: string,
    @Query("status") status?: ToolMigrationStatus,
  ) {
    return { migrations: await this.toolMigrations.list({ toolName, status }) };
  }

  @Delete("tool-creations/:id")
  async deleteCreation(@Param("id") id: string) {
    return this.tools.deleteFailedToolCreation(decodeURIComponent(id));
  }

  /**
   * Phase 13 follow-up: manual tool runner. Lets the operator hit a
   * tool with a hand-crafted input from the UI / curl, get the exact
   * `ToolResult` back, and see if a build is healthy without
   * orchestrating a full agent run. Body: `{ "input": {...} }` (or
   * just the input object directly for terse curl-style calls).
   */
  @Post("tools/:name/run")
  async runManual(@Param("name") name: string, @Body() body: unknown) {
    return this.manualRuns.runToolManually(decodeURIComponent(name), body);
  }

  @Patch("tools/:name/status")
  async setStatus(@Param("name") name: string, @Body() body: unknown) {
    return this.toolAdmin.setToolStatus(decodeURIComponent(name), body);
  }

  @Get("tool-settings")
  async listSettings(@Query("toolName") toolName?: string) {
    return { settings: await this.toolSettings.listSettings(toolName) };
  }

  @Put("tool-settings")
  async setSetting(@Body() body: unknown) {
    return { setting: await this.toolSettings.setSetting(body) };
  }

  @Post("tool-settings/validate")
  async validateSettings(@Body() body: unknown) {
    return this.toolSettings.validateSettings(body);
  }

  @Delete("tool-settings/:toolName/:key")
  async deleteSetting(@Param("toolName") toolName: string, @Param("key") key: string) {
    return this.toolSettings.deleteSetting(decodeURIComponent(toolName), decodeURIComponent(key));
  }

  @Get("tool-package-runners")
  async listPackageRunners() {
    return { runners: await this.toolAdmin.listPackageRunners() };
  }

  @Post("tools/generated-modules")
  @HttpCode(201)
  async registerGenerated(@Body() body: unknown) {
    return { tool: await this.toolAdmin.registerGenerated(body) };
  }

  @Post("tools/package-manifests")
  @HttpCode(201)
  async importPackageManifest(@Body() body: unknown) {
    return { tool: await this.toolAdmin.importPackageManifest(body) };
  }

  @Post("tools/source-bundles")
  @HttpCode(201)
  async importSourceBundle(@Body() body: unknown) {
    return await this.tools.importSourceBundle(body);
  }

  @Get("tools/generated-modules/:name/versions")
  async listVersions(@Param("name") name: string) {
    return { versions: await this.toolAdmin.listVersions(decodeURIComponent(name)) };
  }

  @Post("tools/generated-modules/:name/versions")
  @HttpCode(201)
  async createVersion(@Param("name") name: string, @Body() body: unknown) {
    return await this.tools.createToolVersion(decodeURIComponent(name), body);
  }

  @Post("tools/generated-modules/:name/versions/:version/run")
  async runVersionManual(
    @Param("name") name: string,
    @Param("version") version: string,
    @Body() body: unknown,
  ) {
    return this.manualRuns.runToolVersionManually(
      decodeURIComponent(name),
      decodeURIComponent(version),
      body,
    );
  }

  @Get("tools/generated-modules/:name/package-manifest")
  async getPackageManifest(@Param("name") name: string) {
    return { manifest: await this.toolAdmin.getPackageManifest(decodeURIComponent(name)) };
  }

  @Get("tools/generated-modules/:name/context")
  async listToolContext(@Param("name") name: string) {
    return { context: await this.tools.listToolContext(decodeURIComponent(name)) };
  }

  @Post("tools/generated-modules/:name/context")
  @HttpCode(201)
  async createToolContext(@Param("name") name: string, @Body() body: unknown) {
    return { context: await this.tools.createToolContext(decodeURIComponent(name), body) };
  }

  @Patch("tools/generated-modules/:name/context/:contextId")
  async updateToolContext(
    @Param("contextId") contextId: string,
    @Body() body: unknown,
  ) {
    return { context: await this.tools.updateToolContext(decodeURIComponent(contextId), body) };
  }

  @Delete("tools/generated-modules/:name/context/:contextId")
  async deleteToolContext(@Param("contextId") contextId: string) {
    return this.tools.deleteToolContext(decodeURIComponent(contextId));
  }

  /**
   * Phase 13 — per-tool usage stats. Returns derived metrics
   * (success rate, total runs, per-version aggregates) for the UI
   * tools page; numbers come from the metadata store's existing
   * successCount / failureCount / lastSuccessAt / lastFailureAt.
   */
  @Get("tools/:name/stats")
  async getStats(@Param("name") name: string) {
    return await this.toolAdmin.getToolStats(decodeURIComponent(name));
  }

  /**
   * Phase 13 — export the package manifest as a JSON download. Pair
   * with POST /api/tools/package-manifests on a target instance to
   * import the same blueprint there. The OCI image referenced by
   * the manifest must be published / pulled separately (e.g. via
   * `docker save | docker load`).
   */
  @Get("tools/:name/export")
  async exportPackage(@Param("name") name: string) {
    return await this.toolAdmin.exportPackageManifest(decodeURIComponent(name));
  }

  @Get("tools/:name/source-bundle")
  async exportSourceBundle(@Param("name") name: string) {
    return await this.tools.exportSourceBundle(decodeURIComponent(name));
  }

  @Delete("tools/generated-modules/:name")
  async deleteGenerated(@Param("name") name: string) {
    return this.toolVersions.deleteGenerated(decodeURIComponent(name));
  }

  @Delete("tools/generated-modules/:name/versions/:version")
  async deleteVersion(@Param("name") name: string, @Param("version") version: string) {
    return this.toolVersions.deleteVersion(decodeURIComponent(name), decodeURIComponent(version));
  }

  @Post("tools/generated-modules/:name/versions/:version/mark-available")
  async markVersionAvailable(@Param("name") name: string, @Param("version") version: string) {
    return this.toolVersions.markVersionAvailable(decodeURIComponent(name), decodeURIComponent(version));
  }

  @Post("tools/generated-modules/:name/versions/:version/reject")
  async rejectVersion(
    @Param("name") name: string,
    @Param("version") version: string,
    @Body() body: unknown,
  ) {
    return this.toolVersions.rejectVersion(decodeURIComponent(name), decodeURIComponent(version), body);
  }

  @Post("tools/generated-modules/:name/promote-replacement")
  async promoteReplacement(@Param("name") name: string, @Body() body: unknown) {
    return { tool: await this.tools.promoteReplacement(decodeURIComponent(name), body) };
  }

  @Post("tools/generated-modules/:name/activate-version")
  async activateVersion(@Param("name") name: string, @Body() body: unknown) {
    return { tool: await this.tools.activateVersion(decodeURIComponent(name), body) };
  }
}
