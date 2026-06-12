import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { CreateSecretHandleDto } from "./dto/create-secret-handle.dto.js";
import { SecretsService } from "./secrets.service.js";

@Controller("api/secret-handles")
export class SecretsController {
  constructor(@Inject(SecretsService) private readonly secrets: SecretsService) {}

  @Get()
  async list() {
    return { secretHandles: await this.secrets.list() };
  }

  @Post("status")
  async status(@Body() body: unknown) {
    const handles = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { handles?: unknown }).handles
      : undefined;
    return this.secrets.status(Array.isArray(handles) ? handles.filter((handle): handle is string => typeof handle === "string") : []);
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateSecretHandleDto, @Req() request: Request) {
    return { secretHandle: await this.secrets.create(request.body, dto) };
  }

  @Get(":handle")
  async get(@Param("handle") handle: string) {
    return { secretHandle: await this.secrets.get(decodeURIComponent(handle)) };
  }

  @Delete(":handle")
  async delete(@Param("handle") handle: string) {
    return this.secrets.delete(decodeURIComponent(handle));
  }
}
