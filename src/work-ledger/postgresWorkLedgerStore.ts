import { PgPool } from "../db/pool.js";
import { decideWorkReuse } from "./decideWorkReuse.js";
import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  WorkClaim,
  WorkLedgerCreateInput,
  WorkLedgerItem,
  WorkLedgerKind,
  WorkLedgerStatus,
  WorkLedgerStore,
  WorkLedgerUpdateInput,
  WorkReuseDecision,
} from "./types.js";

type WorkLedgerRow = {
  id: string;
  instance_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  owner_span_id: string | null;
  parent_work_item_id: string | null;
  kind: WorkLedgerKind;
  status: WorkLedgerStatus;
  work_key: string;
  title: string;
  summary: string | null;
  input_summary: string | null;
  output_summary: string | null;
  source_urls: string[] | null;
  artifact_ids: string[] | null;
  evidence_ids: string[] | null;
  error: string | null;
  confidence: number | null;
  freshness_expires_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `id, instance_id, thread_id, run_id, owner_span_id, parent_work_item_id,
  kind, status, work_key, title, summary, input_summary, output_summary,
  source_urls, artifact_ids, evidence_ids, error, confidence, freshness_expires_at,
  metadata, created_at, updated_at`;

export class PostgresWorkLedgerStore implements WorkLedgerStore {
  constructor(private readonly pool: PgPool) {}

  async createItem(input: WorkLedgerCreateInput): Promise<WorkLedgerItem> {
    const id = `work_${input.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const status = input.status ?? "planned";
    const metadata = sanitizeMetadata(input.metadata);
    const rows = await this.pool.query<WorkLedgerRow>(
      `
        insert into work_ledger_items (
          id, instance_id, thread_id, run_id, owner_span_id, parent_work_item_id,
          kind, status, work_key, title, summary, input_summary, output_summary,
          source_urls, artifact_ids, evidence_ids, error, confidence, freshness_expires_at,
          metadata, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          coalesce($14::text[], '{}'::text[]),
          coalesce($15::text[], '{}'::text[]),
          coalesce($16::text[], '{}'::text[]),
          $17, $18, $19, $20, $21, $21
        )
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        nullable(input.instanceId),
        nullable(input.threadId),
        nullable(input.runId),
        nullable(input.ownerSpanId),
        nullable(input.parentWorkItemId),
        input.kind,
        status,
        requireText(input.workKey, "workKey"),
        requireText(input.title, "title"),
        nullable(input.summary),
        nullable(input.inputSummary),
        nullable(input.outputSummary),
        uniqueStringArray(input.sourceUrls),
        uniqueStringArray(input.artifactIds),
        uniqueStringArray(input.evidenceIds),
        nullable(input.error),
        input.confidence ?? null,
        nullable(input.freshnessExpiresAt),
        metadata ? JSON.stringify(metadata) : null,
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async updateItemStatus(id: string, update: WorkLedgerUpdateInput): Promise<WorkLedgerItem> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Work ledger item ${id} was not found`);
    const next: WorkLedgerItem = {
      ...existing,
      status: update.status ?? existing.status,
      ownerSpanId: applyOptionalString(existing.ownerSpanId, update.ownerSpanId),
      summary: applyOptionalString(existing.summary, update.summary),
      inputSummary: applyOptionalString(existing.inputSummary, update.inputSummary),
      outputSummary: applyOptionalString(existing.outputSummary, update.outputSummary),
      sourceUrls: update.sourceUrls ? uniqueStringArray(update.sourceUrls) : existing.sourceUrls,
      error: applyOptionalString(existing.error, update.error),
      confidence: applyOptionalNumber(existing.confidence, update.confidence),
      freshnessExpiresAt: applyOptionalString(existing.freshnessExpiresAt, update.freshnessExpiresAt),
      metadata: update.metadata ? sanitizeMetadata(update.metadata) : existing.metadata,
    };
    const rows = await this.pool.query<WorkLedgerRow>(
      `
        update work_ledger_items
        set status = $2,
            owner_span_id = $3,
            summary = $4,
            input_summary = $5,
            output_summary = $6,
            source_urls = coalesce($7::text[], '{}'::text[]),
            error = $8,
            confidence = $9,
            freshness_expires_at = $10,
            metadata = $11,
            updated_at = $12
        where id = $1
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        next.status,
        nullable(next.ownerSpanId),
        nullable(next.summary),
        nullable(next.inputSummary),
        nullable(next.outputSummary),
        next.sourceUrls,
        nullable(next.error),
        next.confidence ?? null,
        nullable(next.freshnessExpiresAt),
        next.metadata ? JSON.stringify(next.metadata) : null,
        new Date().toISOString(),
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async claimWork(claim: WorkClaim): Promise<{ item: WorkLedgerItem; decision: WorkReuseDecision }> {
    const matches = await this.listByWorkKey(claim.workKey);
    const decision = decideWorkReuse({ existingItems: matches, claim });
    if (
      (decision.status === "reuse_completed" ||
        decision.status === "wait_for_inflight" ||
        decision.status === "blocked_by_recent_failure") &&
      decision.match
    ) {
      return { item: decision.match, decision };
    }
    const created = await this.createItem({
      kind: claim.kind,
      workKey: claim.workKey,
      title: claim.title,
      threadId: claim.threadId,
      runId: claim.runId,
      instanceId: claim.instanceId,
      ownerSpanId: claim.ownerSpanId,
      parentWorkItemId: claim.parentWorkItemId,
      inputSummary: claim.inputSummary,
      freshnessExpiresAt: claim.freshnessExpiresAt,
      metadata: claim.metadata,
      status: "claimed",
    });
    return { item: created, decision };
  }

  async listByThread(threadId: string, limit = 200): Promise<WorkLedgerItem[]> {
    const rows = await this.pool.query<WorkLedgerRow>(
      `select ${SELECT_COLUMNS} from work_ledger_items where thread_id = $1 order by created_at desc limit $2`,
      [threadId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByRun(runId: string, limit = 200): Promise<WorkLedgerItem[]> {
    const rows = await this.pool.query<WorkLedgerRow>(
      `select ${SELECT_COLUMNS} from work_ledger_items where run_id = $1 order by created_at desc limit $2`,
      [runId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByWorkKey(workKey: string, limit = 50): Promise<WorkLedgerItem[]> {
    const rows = await this.pool.query<WorkLedgerRow>(
      `
        select ${SELECT_COLUMNS}
        from work_ledger_items
        where md5(work_key) = md5($1) and work_key = $1
        order by created_at desc
        limit $2
      `,
      [workKey, limit],
    );
    return rows.rows.map(mapRow);
  }

  async get(id: string): Promise<WorkLedgerItem | undefined> {
    const rows = await this.pool.query<WorkLedgerRow>(
      `select ${SELECT_COLUMNS} from work_ledger_items where id = $1`,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async appendEvidenceLink(id: string, evidenceId: string): Promise<WorkLedgerItem> {
    return this.appendArrayLink(id, "evidence_ids", evidenceId);
  }

  async appendArtifactLink(id: string, artifactId: string): Promise<WorkLedgerItem> {
    return this.appendArrayLink(id, "artifact_ids", artifactId);
  }

  private async appendArrayLink(
    id: string,
    column: "evidence_ids" | "artifact_ids",
    value: string,
  ): Promise<WorkLedgerItem> {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${column} entry must be a non-empty string`);
    const rows = await this.pool.query<WorkLedgerRow>(
      `
        update work_ledger_items
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
    if (!rows.rows[0]) throw new Error(`Work ledger item ${id} was not found`);
    return mapRow(rows.rows[0]);
  }
}

function mapRow(row: WorkLedgerRow | undefined): WorkLedgerItem {
  if (!row) throw new Error("Work ledger row was not returned by the database");
  return {
    id: row.id,
    instanceId: row.instance_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    runId: row.run_id ?? undefined,
    ownerSpanId: row.owner_span_id ?? undefined,
    parentWorkItemId: row.parent_work_item_id ?? undefined,
    kind: row.kind,
    status: row.status,
    workKey: row.work_key,
    title: row.title,
    summary: row.summary ?? undefined,
    inputSummary: row.input_summary ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    sourceUrls: row.source_urls ?? [],
    artifactIds: row.artifact_ids ?? [],
    evidenceIds: row.evidence_ids ?? [],
    error: row.error ?? undefined,
    confidence: row.confidence ?? undefined,
    freshnessExpiresAt: row.freshness_expires_at?.toISOString(),
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

function applyOptionalNumber(current: number | undefined, update: number | null | undefined): number | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return typeof update === "number" && Number.isFinite(update) ? update : current;
}
