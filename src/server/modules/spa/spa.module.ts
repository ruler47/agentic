import { Module } from "@nestjs/common";
import { SpaFallbackController } from "./spa.controller.js";

/**
 * Phase 13 follow-up: SPA fallback module. Mounts a single catch-all
 * GET handler that returns `public/index.html` for non-API,
 * non-static-asset URLs so refreshing on `/tools` (or any other
 * hash-routed deep link the user pasted without `#`) lands on the
 * console instead of a Nest 404 JSON.
 */
@Module({
  controllers: [SpaFallbackController],
})
export class SpaModule {}
