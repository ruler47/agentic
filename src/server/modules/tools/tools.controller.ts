import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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

  @Delete("tools/generated-modules/:name")
  async deleteGenerated(@Param("name") name: string) {
    return this.tools.deleteGenerated(decodeURIComponent(name));
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
