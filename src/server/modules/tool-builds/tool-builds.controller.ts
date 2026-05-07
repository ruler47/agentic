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
} from "@nestjs/common";
import { ToolBuildsService } from "./tool-builds.service.js";

@Controller("api/tool-build-requests")
export class ToolBuildsController {
  constructor(@Inject(ToolBuildsService) private readonly builds: ToolBuildsService) {}

  @Get()
  async list() {
    return { requests: await this.builds.list() };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { request: await this.builds.create(body) };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { request: await this.builds.get(decodeURIComponent(id)) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { request: await this.builds.updateStatus(decodeURIComponent(id), body) };
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.builds.delete(decodeURIComponent(id));
  }

  @Post(":id/stop")
  async stop(@Param("id") id: string, @Body() body: unknown) {
    return { request: await this.builds.stop(decodeURIComponent(id), body) };
  }

  @Post(":id/rework")
  @HttpCode(201)
  async rework(@Param("id") id: string, @Body() body: unknown) {
    return this.builds.rework(decodeURIComponent(id), body);
  }

  @Post(":id/run")
  async run(@Param("id") id: string) {
    return this.builds.run(decodeURIComponent(id));
  }
}
