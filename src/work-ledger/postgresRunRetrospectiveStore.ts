import { PgPool } from "../db/pool.js";
import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  RunRetrospectiveCreateInput,
  RunRetrospectiveOutcome,
  RunRetrospectiveProposalKind,
  RunRetrospectiveRecord,
  RunRetrospectiveStatus,
  RunRetrospectiveStore,
  RunRetrospectiveUpdateInput,
} from "./types.js";

type RetrospectiveRow = {
  id: string;
  instance_id: string | null;
  thread_id: string | null;
  run_id: string;
  status: RunRetrospectiveStatus;
  run_outcome: RunRetrospectiveOutcome;
  what_worked: string[] | null;
  what_failed: string[] | null;
  suspected_root_causes: string[] | null;
  duplicated_work: string[] | null;
  weak_tools: string[] | null;
  weak_models: string[] | null;
  missing_capabilities: string[] | null;
  useful_evidence_ids: string[] | null;
  proposed_memory_ids: string[] | null;
  proposed_tool_follow_up_ids: string[] | null;
  proposed_policy_changes: string[] | null;
  proposed_prompt_changes: string[] | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `id, instance_id, thread_id, run_id, status, run_outcome,
  what_worked, what_failed, suspected_root_causes, duplicated_work,
  weak_tools, weak_models, missing_capabilities, useful_evidence_ids,
  proposed_memory_ids, proposed_tool_follow_up_ids,
  proposed_policy_changes, proposed_prompt_changes,
  summary, metadata, created_at, updated_at`;

const PROPOSAL_COLUMN: Record<RunRetrospectiveProposalKind, string> = {
  memory: "proposed_memory_ids",
  tool_follow_up: "proposed_tool_follow_up_ids",
  policy_change: "proposed_policy_changes",
  prompt_change: "proposed_prompt_changes",
};

export class PostgresRunRetrospectiveStore implements RunRetrospectiveStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: RunRetrospectiveCreateInput): Promise<RunRetrospectiveRecord> {
    const id = `retro_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const metadata = sanitizeMetadata(input.metadata);
    const rows = await this.pool.query<RetrospectiveRow>(
      `
        insert into run_retrospectives (
          id, instance_id, thread_id, run_id, status, run_outcome,
          what_worked, what_failed, suspected_root_causes, duplicated_work,
          weak_tools, weak_models, missing_capabilities, useful_evidence_ids,
          proposed_memory_ids, proposed_tool_follow_up_ids,
          proposed_policy_changes, proposed_prompt_changes,
          summary, metadata, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6,
          coalesce($7::text[], '{}'::text[]),
          coalesce($8::text[], '{}'::text[]),
          coalesce($9::text[], '{}'::text[]),
          coalesce($10::text[], '{}'::text[]),
          coalesce($11::text[], '{}'::text[]),
          coalesce($12::text[], '{}'::text[]),
          coalesce($13::text[], '{}'::text[]),
          coalesce($14::text[], '{}'::text[]),
          coalesce($15::text[], '{}'::text[]),
          coalesce($16::text[], '{}'::text[]),
          coalesce($17::text[], '{}'::text[]),
          coalesce($18::text[], '{}'::text[]),
          $19, $20, $21, $21
        )
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        nullable(input.instanceId),
        nullable(input.threadId),
        requireText(input.runId, "runId"),
        input.status ?? "proposed",
        input.runOutcome,
        uniqueStringArray(input.whatWorked),
        uniqueStringArray(input.whatFailed),
        uniqueStringArray(input.suspectedRootCauses),
        uniqueStringArray(input.duplicatedWork),
        uniqueStringArray(input.weakTools),
        uniqueStringArray(input.weakModels),
        uniqueStringArray(input.missingCapabilities),
        uniqueStringArray(input.usefulEvidenceIds),
        uniqueStringArray(input.proposedMemoryIds),
        uniqueStringArray(input.proposedToolFollowUpIds),
        uniqueStringArray(input.proposedPolicyChanges),
        uniqueStringArray(input.proposedPromptChanges),
        nullable(input.summary),
        metadata ? JSON.stringify(metadata) : null,
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<RunRetrospectiveRecord | undefined> {
    const rows = await this.pool.query<RetrospectiveRow>(
      `select ${SELECT_COLUMNS} from run_retrospectives where id = $1`,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async listByRun(runId: string, limit = 50): Promise<RunRetrospectiveRecord[]> {
    const rows = await this.pool.query<RetrospectiveRow>(
      `select ${SELECT_COLUMNS} from run_retrospectives where run_id = $1 order by created_at desc limit $2`,
      [runId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByThread(threadId: string, limit = 100): Promise<RunRetrospectiveRecord[]> {
    const rows = await this.pool.query<RetrospectiveRow>(
      `select ${SELECT_COLUMNS} from run_retrospectives where thread_id = $1 order by created_at desc limit $2`,
      [threadId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async updateStatus(id: string, update: RunRetrospectiveUpdateInput): Promise<RunRetrospectiveRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Run retrospective ${id} was not found`);
    const next: RunRetrospectiveRecord = {
      ...existing,
      status: update.status ?? existing.status,
      summary: applyOptionalString(existing.summary, update.summary),
      whatWorked: update.whatWorked ? uniqueStringArray(update.whatWorked) : existing.whatWorked,
      whatFailed: update.whatFailed ? uniqueStringArray(update.whatFailed) : existing.whatFailed,
      suspectedRootCauses: update.suspectedRootCauses
        ? uniqueStringArray(update.suspectedRootCauses)
        : existing.suspectedRootCauses,
      duplicatedWork: update.duplicatedWork ? uniqueStringArray(update.duplicatedWork) : existing.duplicatedWork,
      weakTools: update.weakTools ? uniqueStringArray(update.weakTools) : existing.weakTools,
      weakModels: update.weakModels ? uniqueStringArray(update.weakModels) : existing.weakModels,
      missingCapabilities: update.missingCapabilities
        ? uniqueStringArray(update.missingCapabilities)
        : existing.missingCapabilities,
      usefulEvidenceIds: update.usefulEvidenceIds
        ? uniqueStringArray(update.usefulEvidenceIds)
        : existing.usefulEvidenceIds,
      metadata: update.metadata ? sanitizeMetadata(update.metadata) : existing.metadata,
    };
    const rows = await this.pool.query<RetrospectiveRow>(
      `
        update run_retrospectives
        set status = $2,
            summary = $3,
            what_worked = coalesce($4::text[], '{}'::text[]),
            what_failed = coalesce($5::text[], '{}'::text[]),
            suspected_root_causes = coalesce($6::text[], '{}'::text[]),
            duplicated_work = coalesce($7::text[], '{}'::text[]),
            weak_tools = coalesce($8::text[], '{}'::text[]),
            weak_models = coalesce($9::text[], '{}'::text[]),
            missing_capabilities = coalesce($10::text[], '{}'::text[]),
            useful_evidence_ids = coalesce($11::text[], '{}'::text[]),
            metadata = $12,
            updated_at = $13
        where id = $1
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        next.status,
        nullable(next.summary),
        next.whatWorked,
        next.whatFailed,
        next.suspectedRootCauses,
        next.duplicatedWork,
        next.weakTools,
        next.weakModels,
        next.missingCapabilities,
        next.usefulEvidenceIds,
        next.metadata ? JSON.stringify(next.metadata) : null,
        new Date().toISOString(),
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async appendLinkedProposal(
    id: string,
    proposalKind: RunRetrospectiveProposalKind,
    proposalId: string,
  ): Promise<RunRetrospectiveRecord> {
    const trimmed = proposalId.trim();
    if (!trimmed) throw new Error("proposalId must be a non-empty string");
    const column = PROPOSAL_COLUMN[proposalKind];
    const rows = await this.pool.query<RetrospectiveRow>(
      `
        update run_retrospectives
        set ${column} = (
          select array_agg(distinct elem)
          from unnest(coalesce(${column}, '{}'::text[]) || array[$2]::text[]) as elem
        ),
        updated_at = $3
        where id = $1
        returning ${SELECT_COLUMNS}
      `,
      [id, trimmed, new Date().toISOString()],
    );
    if (!rows.rows[0]) throw new Error(`Run retrospective ${id} was not found`);
    return mapRow(rows.rows[0]);
  }
}

function mapRow(row: RetrospectiveRow | undefined): RunRetrospectiveRecord {
  if (!row) throw new Error("Run retrospective row was not returned by the database");
  return {
    id: row.id,
    instanceId: row.instance_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    runId: row.run_id,
    status: row.status,
    runOutcome: row.run_outcome,
    whatWorked: row.what_worked ?? [],
    whatFailed: row.what_failed ?? [],
    suspectedRootCauses: row.suspected_root_causes ?? [],
    duplicatedWork: row.duplicated_work ?? [],
    weakTools: row.weak_tools ?? [],
    weakModels: row.weak_models ?? [],
    missingCapabilities: row.missing_capabilities ?? [],
    usefulEvidenceIds: row.useful_evidence_ids ?? [],
    proposedMemoryIds: row.proposed_memory_ids ?? [],
    proposedToolFollowUpIds: row.proposed_tool_follow_up_ids ?? [],
    proposedPolicyChanges: row.proposed_policy_changes ?? [],
    proposedPromptChanges: row.proposed_prompt_changes ?? [],
    summary: row.summary ?? undefined,
    metadata: row.metadata ? (sanitizeForLedger(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function nullable(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function uniqueStringArray(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = nullable(value);
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function applyOptionalString(current: string | undefined, update: string | null | undefined): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return nullable(update) ?? current;
}
