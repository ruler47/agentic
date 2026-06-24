import { PgPool } from "../db/pool.js";
import type { ModelCapability } from "./modelCatalog.js";
import {
  ModelPreferredRole,
  ModelProfileInput,
  ModelProfileRecord,
  ModelProfileStore,
  mergeModelProfileInput,
  modelProfileId,
  normalizeModelProfileInput,
  sortProfiles,
} from "./modelProfileStore.js";

type ModelProfileRow = {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  enabled: boolean;
  capabilities: ModelCapability[];
  capabilities_overridden: boolean;
  preferred_roles: ModelPreferredRole[];
  context_window: number | null;
  max_output_tokens: number | null;
  operator_notes: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresModelProfileStore implements ModelProfileStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ModelProfileRecord[]> {
    const rows = await this.pool.query<ModelProfileRow>(`
      select id, provider_id, model_id, display_name, enabled, capabilities,
             capabilities_overridden, preferred_roles, context_window,
             max_output_tokens, operator_notes, verified_at, created_at, updated_at
      from model_profiles
      order by provider_id asc, model_id asc
    `);
    return sortProfiles(rows.rows.map(mapRow));
  }

  async upsert(input: ModelProfileInput): Promise<ModelProfileRecord> {
    const existing = await this.get(input.providerId, input.modelId);
    const now = new Date().toISOString();
    const profile = normalizeModelProfileInput(
      mergeModelProfileInput(existing, input),
      existing?.createdAt ?? now,
      now,
    );

    await this.pool.query(
      `
        insert into model_profiles (
          id, provider_id, model_id, display_name, enabled, capabilities,
          capabilities_overridden, preferred_roles, context_window, max_output_tokens,
          operator_notes, verified_at, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        on conflict (id) do update
        set display_name = excluded.display_name,
            enabled = excluded.enabled,
            capabilities = excluded.capabilities,
            capabilities_overridden = excluded.capabilities_overridden,
            preferred_roles = excluded.preferred_roles,
            context_window = excluded.context_window,
            max_output_tokens = excluded.max_output_tokens,
            operator_notes = excluded.operator_notes,
            verified_at = excluded.verified_at,
            updated_at = excluded.updated_at
      `,
      [
        profile.id,
        profile.providerId,
        profile.modelId,
        profile.displayName ?? null,
        profile.enabled,
        profile.capabilities,
        profile.capabilitiesOverridden,
        profile.preferredRoles,
        profile.contextWindow ?? null,
        profile.maxOutputTokens ?? null,
        profile.operatorNotes ?? null,
        profile.verifiedAt ?? null,
        profile.createdAt,
        profile.updatedAt,
      ],
    );

    return profile;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from model_profiles where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private async get(
    providerId: string | undefined,
    modelId: string,
  ): Promise<ModelProfileRecord | undefined> {
    const rows = await this.pool.query<ModelProfileRow>(
      `
        select id, provider_id, model_id, display_name, enabled, capabilities,
               capabilities_overridden, preferred_roles, context_window,
               max_output_tokens, operator_notes, verified_at, created_at, updated_at
        from model_profiles
        where id = $1
      `,
      [modelProfileId(providerId, modelId)],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }
}

function mapRow(row: ModelProfileRow): ModelProfileRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name ?? undefined,
    enabled: row.enabled,
    capabilities: row.capabilities,
    capabilitiesOverridden: row.capabilities_overridden,
    preferredRoles: row.preferred_roles,
    contextWindow: row.context_window ?? undefined,
    maxOutputTokens: row.max_output_tokens ?? undefined,
    operatorNotes: row.operator_notes ?? undefined,
    verifiedAt: row.verified_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
