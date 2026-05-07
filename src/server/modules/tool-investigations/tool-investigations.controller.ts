import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { ToolInvestigationsService } from "./tool-investigations.service.js";

@Controller("api/tool-investigations")
export class ToolInvestigationsController {
  constructor(@Inject(ToolInvestigationsService) private readonly investigations: ToolInvestigationsService) {}

  @Get()
  async list() {
    return { investigations: await this.investigations.list() };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { investigation: await this.investigations.create(body) };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { investigation: await this.investigations.get(decodeURIComponent(id)) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { investigation: await this.investigations.update(decodeURIComponent(id), body) };
  }

  @Post(":id/promote")
  @HttpCode(201)
  async promote(@Param("id") id: string, @Body() body: unknown) {
    return this.investigations.promote(decodeURIComponent(id), body);
  }
}
