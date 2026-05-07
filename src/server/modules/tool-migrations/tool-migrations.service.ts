import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseOptionalDate,
  parseOptionalText,
  parseRequiredText,
  sanitizeObject,
} from "../../common/parsers.js";
import {
  validateToolMigrationStatus,
  type ToolMigrationCreateInput,
  type ToolMigrationListOptions,
  type ToolMigrationRecord,
  type ToolMigrationStatus,
  type ToolMigrationStore,
} from "../../../tools/toolMigrationStore.js";
import type {
  ToolPromotionListOptions,
  ToolPromotionRecord,
  ToolPromotionStore,
} from "../../../tools/toolPromotionStore.js";
import {
  TOOL_MIGRATION_STORE,
  TOOL_PROMOTION_STORE,
} from "../../persistence/tokens.js";

@Injectable()
export class ToolMigrationsService {
  constructor(
    @Inject(TOOL_MIGRATION_STORE) private readonly migrations: ToolMigrationStore | undefined,
    @Inject(TOOL_PROMOTION_STORE) private readonly promotions: ToolPromotionStore | undefined,
  ) {}

  async listMigrations(query: ToolMigrationListOptions): Promise<ToolMigrationRecord[]> {
    return this.migrations ? this.migrations.list(query) : [];
  }

  async createMigration(rawBody: unknown): Promise<ToolMigrationRecord> {
    if (!this.migrations) throw new ServiceUnavailableException("Tool migration store is not configured");
    let input: ToolMigrationCreateInput;
    try {
      input = this.parseCreate(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool migration request",
      );
    }
    return this.migrations.create(input);
  }

  async listPromotions(query: ToolPromotionListOptions): Promise<ToolPromotionRecord[]> {
    return this.promotions ? this.promotions.list(query) : [];
  }

  parseStatusQuery(value: string | undefined): ToolMigrationStatus | undefined {
    if (!value) return undefined;
    return validateToolMigrationStatus(value);
  }

  private parseCreate(value: unknown): ToolMigrationCreateInput {
    if (!isRecord(value)) {
      throw new Error("tool migration request must be an object");
    }
    return {
      toolName: parseRequiredText(value.toolName, "toolName"),
      toolVersion: parseRequiredText(value.toolVersion, "toolVersion"),
      migrationId: parseRequiredText(value.migrationId, "migrationId"),
      checksum: parseRequiredText(value.checksum, "checksum"),
      status: value.status === undefined ? undefined : validateToolMigrationStatus(String(value.status)),
      appliedAt: parseOptionalDate(value.appliedAt, "appliedAt"),
      appliedByActor: parseOptionalText(value.appliedByActor),
      qaReport: isRecord(value.qaReport) ? sanitizeObject(value.qaReport) : undefined,
      rollbackNotes: parseOptionalText(value.rollbackNotes),
    };
  }
}
