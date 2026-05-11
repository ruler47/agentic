import { Module } from "@nestjs/common";
import {
  ConversationsAliasController,
  ConversationsController,
} from "./conversations.controller.js";
import { ConversationsService } from "./conversations.service.js";

@Module({
  controllers: [ConversationsController, ConversationsAliasController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
