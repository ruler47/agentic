import {
  Body,
  Controller,
  Delete,
  Get,
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
}
