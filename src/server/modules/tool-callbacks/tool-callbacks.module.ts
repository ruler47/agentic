import { Module } from "@nestjs/common";
import { ToolCallbacksController } from "./tool-callbacks.controller.js";
import { ToolCallbacksService } from "./tool-callbacks.service.js";

/**
 * Phase 13 — exposes the `/api/tools/callbacks/*` HTTP surface that
 * dockerized tool services use to call back into the runtime. The
 * `TOOL_CALLBACK_TOKEN_ISSUER` provider is supplied globally by
 * `PersistenceModule` so the same issuer is shared between callback
 * verification (here) and callback envelope issuance (universal
 * agent at tool-invocation time).
 */
@Module({
  controllers: [ToolCallbacksController],
  providers: [ToolCallbacksService],
  exports: [ToolCallbacksService],
})
export class ToolCallbacksModule {}
