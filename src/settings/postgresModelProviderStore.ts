import { PgPool } from "../db/pool.js";
import {
  defaultModelProvidersFromEnv,
  ModelProviderHealthStatus,
  ModelProviderInput,
  ModelProviderKind,
  ModelProviderRecord,
  ModelProviderStatus,
  ModelProviderStore,
  ModelProviderType,
  ModelProviderUpdateInput,
  normalizeProviderInput,
  sortProviders,
} from "./modelProviderStore.js";

type ModelProviderRow = {
  id: string;
  label: string;
  kind: ModelProviderKind;
  provider_type: ModelProviderType;
  base_url: string | null;
  model_ids: string[];
  default_model: string | null;
  api_key_secret_handle: string | null;
  dimensions: number | null;
  status: ModelProviderStatus;
  health_status: ModelProviderHealthStatus;
  health_detail: string | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresModelProviderStore implements ModelProviderStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ModelProviderRecord[]> {
    const rows = await this.pool.query<ModelProviderRow>(`
      select id, label, kind, provider_type, base_url, model_ids, default_model,
             api_key_secret_handle, dimensions, status, health_status, health_detail,
             created_at, updated_at
      from model_providers
      order by kind asc, label asc
    `);

    if (rows.rows.length === 0) {
      for (const provider of defaultModelProvidersFromEnv()) {
        await this.create(provider);
      }
      return this.list();
    }

    return sortProviders(rows.rows.map(mapRow));
  }

  async create(input: ModelProviderInput): Promise<ModelProviderRecord> {
    const now = new Date().toISOString();
    const provider = normalizeProviderInput(input, now, now);
    await this.pool.query(
      `
        insert into model_providers (
          id, label, kind, provider_type, base_url, model_ids, default_model,
          api_key_secret_handle, dimensions, status, health_status, health_detail,
          created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        provider.id,
        provider.label,
        provider.kind,
        provider.providerType,
        provider.baseUrl ?? null,
        provider.modelIds,
        provider.defaultModel ?? null,
        provider.apiKeySecretHandle ?? null,
        provider.dimensions ?? null,
        provider.status,
        provider.healthStatus,
        provider.healthDetail ?? null,
        provider.createdAt,
        provider.updatedAt,
      ],
    );
    return provider;
  }

  async update(id: string, input: ModelProviderUpdateInput): Promise<ModelProviderRecord> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Model provider not found: ${id}`);
    }

    const updated = normalizeProviderInput(
      {
        id: existing.id,
        label: input.label ?? existing.label,
        kind: input.kind ?? existing.kind,
        providerType: input.providerType ?? existing.providerType,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        modelIds: input.modelIds ?? existing.modelIds,
        defaultModel: input.defaultModel ?? existing.defaultModel,
        apiKeySecretHandle: input.apiKeySecretHandle ?? existing.apiKeySecretHandle,
        dimensions: input.dimensions ?? existing.dimensions,
        status: input.status ?? existing.status,
        healthStatus: input.healthStatus ?? existing.healthStatus,
        healthDetail: input.healthDetail ?? existing.healthDetail,
      },
      existing.createdAt,
      new Date().toISOString(),
    );

    await this.pool.query(
      `
        update model_providers
        set label = $2,
            kind = $3,
            provider_type = $4,
            base_url = $5,
            model_ids = $6,
            default_model = $7,
            api_key_secret_handle = $8,
            dimensions = $9,
            status = $10,
            health_status = $11,
            health_detail = $12,
            updated_at = $13
        where id = $1
      `,
      [
        updated.id,
        updated.label,
        updated.kind,
        updated.providerType,
        updated.baseUrl ?? null,
        updated.modelIds,
        updated.defaultModel ?? null,
        updated.apiKeySecretHandle ?? null,
        updated.dimensions ?? null,
        updated.status,
        updated.healthStatus,
        updated.healthDetail ?? null,
        updated.updatedAt,
      ],
    );

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`delete from model_providers where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private async get(id: string): Promise<ModelProviderRecord | undefined> {
    const rows = await this.pool.query<ModelProviderRow>(
      `
        select id, label, kind, provider_type, base_url, model_ids, default_model,
               api_key_secret_handle, dimensions, status, health_status, health_detail,
               created_at, updated_at
        from model_providers
        where id = $1
      `,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }
}

function mapRow(row: ModelProviderRow): ModelProviderRecord {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    providerType: row.provider_type,
    baseUrl: row.base_url ?? undefined,
    modelIds: row.model_ids,
    defaultModel: row.default_model ?? undefined,
    apiKeySecretHandle: row.api_key_secret_handle ?? undefined,
    dimensions: row.dimensions ?? undefined,
    status: row.status,
    healthStatus: row.health_status,
    healthDetail: row.health_detail ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
