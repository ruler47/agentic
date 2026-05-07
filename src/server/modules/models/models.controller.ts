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
} from "@nestjs/common";
import {
  CreateModelProviderDto,
  UpdateModelProviderDto,
} from "./dto/model-provider.dto.js";
import { UpdateTiersDto } from "./dto/update-tiers.dto.js";
import { ModelsService } from "./models.service.js";

@Controller("api")
export class ModelsController {
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get("settings/model-tiers")
  async listTiers() {
    return { tiers: await this.models.listTiers() };
  }

  @Put("settings/model-tiers")
  async updateTiers(@Body() dto: UpdateTiersDto) {
    return { tiers: await this.models.updateTiers(dto) };
  }

  @Get("models/catalog")
  async catalog() {
    return this.models.catalog();
  }

  @Get("model-providers")
  async listProviders() {
    return { providers: await this.models.listProviders() };
  }

  @Post("model-providers")
  @HttpCode(201)
  async createProvider(@Body() dto: CreateModelProviderDto) {
    return { provider: await this.models.createProvider(dto) };
  }

  @Patch("model-providers/:id")
  async updateProvider(@Param("id") id: string, @Body() dto: UpdateModelProviderDto) {
    return { provider: await this.models.updateProvider(decodeURIComponent(id), dto) };
  }

  @Delete("model-providers/:id")
  async deleteProvider(@Param("id") id: string) {
    return this.models.deleteProvider(decodeURIComponent(id));
  }
}
