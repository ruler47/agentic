import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CODING_COUNCIL_STORE } from "../../persistence/tokens.js";
import type {
  CodingCouncilConfig,
  CodingCouncilStore,
} from "../../../settings/codingCouncilStore.js";

const DEFAULT_INSTANCE_ID = "instance-local";

/**
 * Phase 14: API surface for the coding-council config. UI calls these
 * from the Settings page to pick which model tier acts as the tool-build
 * council and how aggressive the loop limits are.
 */
@Controller("api/settings")
export class CodingCouncilController {
  constructor(
    @Inject(CODING_COUNCIL_STORE) private readonly store: CodingCouncilStore | undefined,
  ) {}

  @Get("coding-council")
  async get(): Promise<{ config: CodingCouncilConfig }> {
    if (!this.store) throw new ServiceUnavailableException("Coding council store is not configured");
    return { config: await this.store.get(DEFAULT_INSTANCE_ID) };
  }

  @Put("coding-council")
  async update(@Body() body: unknown): Promise<{ config: CodingCouncilConfig }> {
    if (!this.store) throw new ServiceUnavailableException("Coding council store is not configured");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("Body must be an object.");
    }
    const input = body as Record<string, unknown>;
    return {
      config: await this.store.update({
        instanceId: DEFAULT_INSTANCE_ID,
        tier: typeof input.tier === "string" ? (input.tier as CodingCouncilConfig["tier"]) : undefined,
        maxRevisionAttempts:
          typeof input.maxRevisionAttempts === "number" ? input.maxRevisionAttempts : undefined,
        maxQaRepairAttempts:
          typeof input.maxQaRepairAttempts === "number" ? input.maxQaRepairAttempts : undefined,
        qaTimeoutMs: typeof input.qaTimeoutMs === "number" ? input.qaTimeoutMs : undefined,
        brainstormSystemPrompt:
          typeof input.brainstormSystemPrompt === "string" ? input.brainstormSystemPrompt : undefined,
      }),
    };
  }
}
