import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ToolCallbackTokenError, ToolCallbackTokenIssuer } from "../../../tools/toolCallbackToken.js";
import { TOOL_CALLBACK_TOKEN_ISSUER } from "../../persistence/tokens.js";
import { ToolCallbacksService } from "./tool-callbacks.service.js";

/**
 * Phase 13 — HTTP endpoints that tool service containers call back
 * into the runtime to persist artifacts, claim work-ledger work,
 * search shared memory, or emit run events. The runtime issued the
 * tool a short-lived JWT-style token (see `ToolCallbackTokenIssuer`)
 * scoped to a single run + tool name; every callback verifies the
 * `Authorization: Bearer <token>` header before routing the request.
 */
@Controller("api/tools/callbacks")
export class ToolCallbacksController {
  constructor(
    @Inject(TOOL_CALLBACK_TOKEN_ISSUER)
    private readonly tokens: ToolCallbackTokenIssuer,
    @Inject(ToolCallbacksService)
    private readonly service: ToolCallbacksService,
  ) {}

  @Get("ping")
  ping() {
    return { ok: true };
  }

  @Post("artifacts")
  @HttpCode(201)
  async saveArtifact(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const claims = this.requireToken(authorization, "artifacts.save");
    return this.service.saveArtifact(claims, body);
  }

  @Post("ledger/claim")
  @HttpCode(201)
  async ledgerClaim(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const claims = this.requireToken(authorization, "ledger.claim");
    return this.service.ledgerClaim(claims, body);
  }

  @Post("memory/search")
  async memorySearch(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const claims = this.requireToken(authorization, "memory.search");
    return this.service.memorySearch(claims, body);
  }

  @Post("events")
  @HttpCode(201)
  async emitRunEvent(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const claims = this.requireToken(authorization, "events.emit");
    return this.service.emitRunEvent(claims, body);
  }

  private requireToken(
    authorization: string | undefined,
    scope: "artifacts.save" | "ledger.claim" | "memory.search" | "events.emit",
  ) {
    if (!authorization) {
      throw new UnauthorizedException("Missing Authorization header");
    }
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new UnauthorizedException("Authorization header must be Bearer <token>");
    }
    const token = match[1]?.trim();
    if (!token) throw new UnauthorizedException("Empty bearer token");
    try {
      const claims = this.tokens.verify(token);
      try {
        this.tokens.assertScope(claims, scope);
      } catch (error) {
        throw new ForbiddenException(error instanceof Error ? error.message : String(error));
      }
      return claims;
    } catch (error) {
      if (error instanceof ToolCallbackTokenError) {
        throw new UnauthorizedException(error.message);
      }
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : "Token verification failed");
    }
  }
}
