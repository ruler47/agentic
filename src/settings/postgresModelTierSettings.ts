import { PgPool } from "../db/pool.js";
import { ModelTier, ModelTierSettings } from "../types.js";
import {
  defaultModelTierSettings,
  ModelTierSettingsInput,
  ModelTierSettingsStore,
  normalizeSettings,
} from "./modelTierSettings.js";

type ModelTierSettingsRow = {
  tier: ModelTier;
  models: string[];
  max_attempts: number;
  escalate_on_failure: boolean;
  updated_at: Date;
};

export class PostgresModelTierSettingsStore implements ModelTierSettingsStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ModelTierSettings[]> {
    const rows = await this.pool.query<ModelTierSettingsRow>(`
      select tier, models, max_attempts, escalate_on_failure, updated_at
      from model_tier_settings
      order by case tier when 'S' then 1 when 'M' then 2 when 'L' then 3 when 'XL' then 4 else 5 end
    `);

    if (rows.rows.length === 0) {
      return this.replace(defaultModelTierSettings());
    }

    return rows.rows.map(mapRow);
  }

  async replace(settings: ModelTierSettingsInput[]): Promise<ModelTierSettings[]> {
    const normalized = normalizeSettings(settings, new Date().toISOString());

    await this.pool.query("begin");
    try {
      await this.pool.query("delete from model_tier_settings");
      for (const item of normalized) {
        await this.pool.query(
          `
            insert into model_tier_settings (
              tier, models, max_attempts, escalate_on_failure, updated_at
            )
            values ($1, $2, $3, $4, $5)
          `,
          [item.tier, item.models, item.maxAttempts, item.escalateOnFailure, item.updatedAt],
        );
      }
      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }

    return this.list();
  }
}

function mapRow(row: ModelTierSettingsRow): ModelTierSettings {
  return {
    tier: row.tier,
    models: row.models,
    maxAttempts: row.max_attempts,
    escalateOnFailure: row.escalate_on_failure,
    updatedAt: row.updated_at.toISOString(),
  };
}
