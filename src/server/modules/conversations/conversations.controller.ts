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

/**
 * Phase 13 follow-up: shorter alias mounted at `/api/threads`. The
 * payload returned by `POST /api/runs` includes `threadId` and the
 * thread inline as `thread`, but a follow-up GET to refetch by id was
 * easy to miss: the canonical mount is `/api/conversation-threads/:id`.
 * Adding `/api/threads/:id` (and the list / delete variants) means
 * curl, smoke tests, and external integrations can use the obvious
 * name without first reading the controller table.
 */
@Controller("api/threads")
export class ConversationsAliasController {
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
