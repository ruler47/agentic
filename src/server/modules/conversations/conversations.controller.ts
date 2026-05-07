import { Controller, Delete, Get, Inject, Param } from "@nestjs/common";
import { ConversationsService } from "./conversations.service.js";

@Controller("api/conversation-threads")
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Get()
  async list() {
    return { threads: await this.conversations.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { thread: await this.conversations.get(decodeURIComponent(id)) };
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.conversations.delete(decodeURIComponent(id));
  }
}
