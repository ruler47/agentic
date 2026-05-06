import { PgPool } from "../db/pool.js";
import { ToolBuildOutput } from "./toolBuildWorkflow.js";
import { ToolBuildQaReport, ToolBuildRequest } from "./toolBuildRequestStore.js";
import { PostgresToolMetadataStore } from "./postgresToolMetadataStore.js";
import { PostgresToolMigrationStore } from "./postgresToolMigrationStore.js";
import { PostgresToolPromotionStore } from "./postgresToolPromotionStore.js";
import {
  ToolPromotionCoordinator,
  ToolPromotionCoordinatorResult,
} from "./toolPromotionCoordinator.js";

export class PostgresToolPromotionCoordinator {
  constructor(private readonly pool: PgPool) {}

  async promote(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport?: ToolBuildQaReport,
  ): Promise<ToolPromotionCoordinatorResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const coordinator = new ToolPromotionCoordinator(
        new PostgresToolMetadataStore(client, { autoTransactionWrites: false }),
        new PostgresToolMigrationStore(client),
        new PostgresToolPromotionStore(client),
      );
      const result = await coordinator.promote(request, output, qaReport);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
