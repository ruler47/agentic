import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CreateMemoryDto } from "./dto/create-memory.dto.js";
import { EvaluateRetrievalDto } from "./dto/evaluate-retrieval.dto.js";
import { UpdateMemoryDto } from "./dto/update-memory.dto.js";
import { MemoryService } from "./memory.service.js";

@Controller("api/memories")
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  async list(@Query() query: Record<string, string>) {
    return { memories: await this.memory.list(query) };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateMemoryDto) {
    return { memory: await this.memory.create(dto) };
  }

  @Post("reembed")
  async reembed() {
    return this.memory.reembed();
  }

  @Post("evaluate-retrieval")
  async evaluateRetrieval(@Body() dto: EvaluateRetrievalDto) {
    return this.memory.evaluateRetrieval(dto);
  }

  @Get("review-queue")
  async reviewQueue() {
    return this.memory.reviewQueue();
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() dto: UpdateMemoryDto) {
    return { memory: await this.memory.update(decodeURIComponent(id), dto) };
  }
}
