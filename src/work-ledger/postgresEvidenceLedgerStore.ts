import { PgPool } from "../db/pool.js";
import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  EvidenceCreateInput,
  EvidenceKind,
  EvidenceLedgerStore,
  EvidenceQaStatus,
  EvidenceRecord,
} from "./types.js";

type EvidenceRow = {
  id: string;
  instance_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  span_id: string | null;
  work_item_id: string | null;
  kind: EvidenceKind;
  source_url: string | null;
  provider: string | null;
  tool_name: string | null;
  title: string;
  summary: string | null;
  content_preview: string | null;
  artifact_id: string | null;
  qa_status: EvidenceQaStatus;
  confidence: number | null;
  limitations: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

const SELECT_COLUMNS = `id, instance_id, thread_id, run_id, span_id, work_item_id, kind,
  source_url, provider, tool_name, title, summary, content_preview, artifact_id,
  qa_status, confidence, limitations, metadata, created_at`;

export class PostgresEvidenceLedgerStore implements EvidenceLedgerStore {
  constructor(private readonly pool: PgPool) {}

  async createEvidence(input: EvidenceCreateInput): Promise<EvidenceRecord> {
    const id = `evidence_${input.kind}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const metadata = sanitizeMetadata(input.metadata);
    const rows = await this.pool.query<EvidenceRow>(
      `
        insert into evidence_ledger_records (
          id, instance_id, thread_id, run_id, span_id, work_item_id, kind,
          source_url, provider, tool_name, title, summary, content_preview, artifact_id,
          qa_status, confidence, limitations, metadata, created_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, coalesce($17::text[], '{}'::text[]), $18, $19
        )
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        nullable(input.instanceId),
        nullable(input.threadId),
        nullable(input.runId),
        nullable(input.spanId),
        nullable(input.workItemId),
        input.kind,
        nullable(input.sourceUrl),
        nullable(input.provider),
        nullable(input.toolName),
        requireText(input.title, "title"),
        nullable(input.summary),
        nullable(input.contentPreview),
        nullable(input.artifactId),
        input.qaStatus ?? "unchecked",
        input.confidence ?? null,
        uniqueStringArray(input.limitations),
        metadata ? JSON.stringify(metadata) : null,
        new Date().toISOString(),
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<EvidenceRecord | undefined> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where id = $1`,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async listByThread(threadId: string, limit = 200): Promise<EvidenceRecord[]> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where thread_id = $1 order by created_at desc limit $2`,
      [threadId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByRun(runId: string, limit = 200): Promise<EvidenceRecord[]> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where run_id = $1 order by created_at desc limit $2`,
      [runId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByWorkItem(workItemId: string, limit = 200): Promise<EvidenceRecord[]> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where work_item_id = $1 order by created_at desc limit $2`,
      [workItemId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByArtifact(artifactId: string, limit = 100): Promise<EvidenceRecord[]> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where artifact_id = $1 order by created_at desc limit $2`,
      [artifactId, limit],
    );
    return rows.rows.map(mapRow);
  }

  async listBySourceUrl(sourceUrl: string, limit = 100): Promise<EvidenceRecord[]> {
    const rows = await this.pool.query<EvidenceRow>(
      `select ${SELECT_COLUMNS} from evidence_ledger_records where source_url = $1 order by created_at desc limit $2`,
      [sourceUrl, limit],
    );
    return rows.rows.map(mapRow);
  }
}

function mapRow(row: EvidenceRow | undefined): EvidenceRecord {
  if (!row) throw new Error("Evidence row was not returned by the database");
  return {
    id: row.id,
    instanceId: row.instance_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    runId: row.run_id ?? undefined,
    spanId: row.span_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    kind: row.kind,
    sourceUrl: row.source_url ?? undefined,
    provider: row.provider ?? undefined,
    toolName: row.tool_name ?? undefined,
    title: row.title,
    summary: row.summary ?? undefined,
    contentPreview: row.content_preview ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    qaStatus: row.qa_status,
    confidence: row.confidence ?? undefined,
    limitations: row.limitations ?? [],
    metadata: row.metadata ? (sanitizeForLedger(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: row.created_at.toISOString(),
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
