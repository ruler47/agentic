import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from "@nestjs/common";
import { ToolMigrationsService } from "./tool-migrations.service.js";

@Controller("api")
export class ToolMigrationsController {
  constructor(@Inject(ToolMigrationsService) private readonly migrations: ToolMigrationsService) {}

  @Get("tool-migrations")
  async listMigrations(@Query("toolName") toolName?: string, @Query("status") status?: string) {
    let parsedStatus;
    try {
      parsedStatus = this.migrations.parseStatusQuery(status);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid status filter");
    }
    return {
      migrations: await this.migrations.listMigrations({
        toolName: toolName?.trim() || undefined,
        status: parsedStatus,
      }),
    };
  }

  @Post("tool-migrations")
  @HttpCode(201)
  async createMigration(@Body() body: unknown) {
    return { migration: await this.migrations.createMigration(body) };
  }

  @Get("tool-promotions")
  async listPromotions(
    @Query("toolName") toolName?: string,
    @Query("buildRequestId") buildRequestId?: string,
  ) {
    return {
      promotions: await this.migrations.listPromotions({
        toolName: toolName?.trim() || undefined,
        buildRequestId: buildRequestId?.trim() || undefined,
      }),
    };
  }
}
