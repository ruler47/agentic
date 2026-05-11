/**
 * Phase 14 — Coding Council settings.
 *
 * The coding council is the pool of LLMs that compete to build a
 * tool. We don't keep a separate list of model ids: `model_tier_settings`
 * already stores `models text[]` per tier, so the council is "every
 * model registered under tier `<councilTier>`". Operator picks the
 * tier (default L) plus tunes the loop parameters (max revisions /
 * QA repairs / QA timeout / optional brainstorm system prompt).
 */
import type { PgPool } from "../db/pool.js";

export type CodingCouncilConfig = {
  instanceId: string;
  tier: "S" | "M" | "L" | "XL";
  maxRevisionAttempts: number;
  maxQaRepairAttempts: number;
  qaTimeoutMs: number;
  /** Optional override for the brainstorm system prompt. */
  brainstormSystemPrompt?: string;
  updatedAt: string;
};

export type CodingCouncilStore = {
  get(instanceId: string): Promise<CodingCouncilConfig>;
  update(config: Partial<CodingCouncilConfig> & { instanceId: string }): Promise<CodingCouncilConfig>;
};

const DEFAULTS: Omit<CodingCouncilConfig, "instanceId" | "updatedAt"> = {
  tier: "L",
  maxRevisionAttempts: 3,
  maxQaRepairAttempts: 5,
  qaTimeoutMs: 30_000,
  brainstormSystemPrompt: undefined,
};

export class InMemoryCodingCouncilStore implements CodingCouncilStore {
  private readonly records = new Map<string, CodingCouncilConfig>();

  async get(instanceId: string): Promise<CodingCouncilConfig> {
    return (
      this.records.get(instanceId) ?? {
        instanceId,
        ...DEFAULTS,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  async update(input: Partial<CodingCouncilConfig> & { instanceId: string }): Promise<CodingCouncilConfig> {
    const current = await this.get(input.instanceId);
    const next: CodingCouncilConfig = {
      ...current,
      tier: normalizeTier(input.tier ?? current.tier),
      maxRevisionAttempts: clampPositiveInt(input.maxRevisionAttempts ?? current.maxRevisionAttempts, 1, 10),
      maxQaRepairAttempts: clampPositiveInt(input.maxQaRepairAttempts ?? current.maxQaRepairAttempts, 1, 10),
      qaTimeoutMs: clampPositiveInt(input.qaTimeoutMs ?? current.qaTimeoutMs, 1_000, 600_000),
      brainstormSystemPrompt:
        input.brainstormSystemPrompt === undefined
          ? current.brainstormSystemPrompt
          : input.brainstormSystemPrompt.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(input.instanceId, next);
    return next;
  }
}

export class PostgresCodingCouncilStore implements CodingCouncilStore {
  constructor(private readonly pool: PgPool) {}

  async get(instanceId: string): Promise<CodingCouncilConfig> {
    const result = await this.pool.query<{
      tier: CodingCouncilConfig["tier"];
      max_revision_attempts: number;
      max_qa_repair_attempts: number;
      qa_timeout_ms: number;
      brainstorm_system_prompt: string | null;
      updated_at: Date;
    }>(
      `select tier, max_revision_attempts, max_qa_repair_attempts, qa_timeout_ms,
              brainstorm_system_prompt, updated_at
         from coding_council_config where instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        instanceId,
        ...DEFAULTS,
        updatedAt: new Date(0).toISOString(),
      };
    }
    return {
      instanceId,
      tier: row.tier,
      maxRevisionAttempts: row.max_revision_attempts,
      maxQaRepairAttempts: row.max_qa_repair_attempts,
      qaTimeoutMs: row.qa_timeout_ms,
      brainstormSystemPrompt: row.brainstorm_system_prompt ?? undefined,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async update(input: Partial<CodingCouncilConfig> & { instanceId: string }): Promise<CodingCouncilConfig> {
    const current = await this.get(input.instanceId);
    const next: CodingCouncilConfig = {
      ...current,
      tier: normalizeTier(input.tier ?? current.tier),
      maxRevisionAttempts: clampPositiveInt(input.maxRevisionAttempts ?? current.maxRevisionAttempts, 1, 10),
      maxQaRepairAttempts: clampPositiveInt(input.maxQaRepairAttempts ?? current.maxQaRepairAttempts, 1, 10),
      qaTimeoutMs: clampPositiveInt(input.qaTimeoutMs ?? current.qaTimeoutMs, 1_000, 600_000),
      brainstormSystemPrompt:
        input.brainstormSystemPrompt === undefined
          ? current.brainstormSystemPrompt
          : input.brainstormSystemPrompt.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.pool.query(
      `insert into coding_council_config
         (instance_id, tier, max_revision_attempts, max_qa_repair_attempts, qa_timeout_ms, brainstorm_system_prompt, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (instance_id) do update set
           tier = excluded.tier,
           max_revision_attempts = excluded.max_revision_attempts,
           max_qa_repair_attempts = excluded.max_qa_repair_attempts,
           qa_timeout_ms = excluded.qa_timeout_ms,
           brainstorm_system_prompt = excluded.brainstorm_system_prompt,
           updated_at = excluded.updated_at`,
      [
        next.instanceId,
        next.tier,
        next.maxRevisionAttempts,
        next.maxQaRepairAttempts,
        next.qaTimeoutMs,
        next.brainstormSystemPrompt ?? null,
        next.updatedAt,
      ],
    );
    return next;
  }
}

function normalizeTier(value: unknown): CodingCouncilConfig["tier"] {
  if (value === "S" || value === "M" || value === "L" || value === "XL") return value;
  return DEFAULTS.tier;
}

function clampPositiveInt(value: number, min: number, max: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}
