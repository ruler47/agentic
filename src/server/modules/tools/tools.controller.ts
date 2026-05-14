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
import { ToolsService } from "./tools.service.js";

@Controller("api")
export class ToolsController {
  constructor(@Inject(ToolsService) private readonly tools: ToolsService) {}

  @Get("tools")
  async list() {
    return { tools: await this.tools.listTools() };
  }

  @Get("tools/health")
  async health() {
    return { tools: await this.tools.toolHealth() };
  }

  @Post("tools/reload-generated")
  async reload() {
    return this.tools.reloadGenerated();
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
    return this.tools.runToolManually(decodeURIComponent(name), body);
  }

  @Get("tool-settings")
  async listSettings(@Query("toolName") toolName?: string) {
    return { settings: await this.tools.listSettings(toolName) };
  }

  @Put("tool-settings")
  async setSetting(@Body() body: unknown) {
    return { setting: await this.tools.setSetting(body) };
  }

  @Post("tool-settings/validate")
  async validateSettings(@Body() body: unknown) {
    return this.tools.validateSettings(body);
  }

  @Delete("tool-settings/:toolName/:key")
  async deleteSetting(@Param("toolName") toolName: string, @Param("key") key: string) {
    return this.tools.deleteSetting(decodeURIComponent(toolName), decodeURIComponent(key));
  }

  @Get("tool-package-runners")
  async listPackageRunners() {
    return { runners: await this.tools.listPackageRunners() };
  }

  @Post("tools/generated-modules")
  @HttpCode(201)
  async registerGenerated(@Body() body: unknown) {
    return { tool: await this.tools.registerGenerated(body) };
  }

  @Post("tools/package-manifests")
  @HttpCode(201)
  async importPackageManifest(@Body() body: unknown) {
    return { tool: await this.tools.importPackageManifest(body) };
  }

  @Get("tools/generated-modules/:name/versions")
  async listVersions(@Param("name") name: string) {
    return { versions: await this.tools.listVersions(decodeURIComponent(name)) };
  }

  @Get("tools/generated-modules/:name/package-manifest")
  async getPackageManifest(@Param("name") name: string) {
    return { manifest: await this.tools.getPackageManifest(decodeURIComponent(name)) };
  }

  /**
   * Phase 13 — per-tool usage stats. Returns derived metrics
   * (success rate, total runs, per-version aggregates) for the UI
   * tools page; numbers come from the metadata store's existing
   * successCount / failureCount / lastSuccessAt / lastFailureAt.
   */
  @Get("tools/:name/stats")
  async getStats(@Param("name") name: string) {
    return await this.tools.getToolStats(decodeURIComponent(name));
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
    return await this.tools.exportPackageManifest(decodeURIComponent(name));
  }

  /**
   * Phase 28 follow-up — operator-edit tool metadata.
   *
   * PATCH body shape:
   *   { description?, displayName?, capabilities? }
   *
   * All fields optional; at least one required. Council reworks
   * regenerate description+capabilities from source code, so this
   * edit is the operator's override "until the next rework". Use
   * for cases where the council-synthesized text isn't accurate
   * enough for downstream agents to pick the right tool.
   */
  @Patch("tools/generated-modules/:name")
  async patchGenerated(@Param("name") name: string, @Body() body: unknown) {
    const patch =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { description?: string; displayName?: string; capabilities?: string[] })
        : {};
    return this.tools.patchGeneratedMetadata(decodeURIComponent(name), patch);
  }

  @Delete("tools/generated-modules/:name")
  async deleteGenerated(@Param("name") name: string) {
    return this.tools.deleteGenerated(decodeURIComponent(name));
  }

  @Delete("tools/generated-modules/:name/versions/:version")
  async deleteVersion(@Param("name") name: string, @Param("version") version: string) {
    return this.tools.deleteVersion(decodeURIComponent(name), decodeURIComponent(version));
  }

  @Post("tools/generated-modules/:name/versions/:version/mark-available")
  async markVersionAvailable(@Param("name") name: string, @Param("version") version: string) {
    return this.tools.markVersionAvailable(decodeURIComponent(name), decodeURIComponent(version));
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
