import { PgPool } from "../db/pool.js";
import {
  sanitizeContextBundle,
  ToolInvestigationContextBundle,
  ToolInvestigationCreateInput,
  ToolInvestigationRecord,
  ToolInvestigationSource,
  ToolInvestigationStatus,
  ToolInvestigationStore,
  ToolInvestigationUpdateInput,
} from "./toolInvestigationStore.js";

type ToolInvestigationRow = {
  id: string;
  status: ToolInvestigationStatus;
  source: ToolInvestigationSource;
  title: string;
  operator_comment: string | null;
  run_id: string | null;
  span_id: string | null;
  tool_name: string | null;
  tool_version: string | null;
  artifact_ids: string[] | null;
  linked_build_request_id: string | null;
  context_bundle: ToolInvestigationContextBundle | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresToolInvestigationStore implements ToolInvestigationStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: ToolInvestigationCreateInput): Promise<ToolInvestigationRecord> {
    const now = new Date().toISOString();
    const id = `inv_${input.source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sanitizedContext = sanitizeContextBundle(input.contextBundle);
    const artifactIds = uniqueStringArray(input.artifactIds);

    const rows = await this.pool.query<ToolInvestigationRow>(
      `
        insert into tool_investigations (
          id, status, source, title, operator_comment, run_id, span_id,
          tool_name, tool_version, artifact_ids, linked_build_request_id,
          context_bundle, created_at, updated_at
        )
        values ($1, 'open', $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $11, $11)
        returning id, status, source, title, operator_comment, run_id, span_id,
                  tool_name, tool_version, artifact_ids, linked_build_request_id,
                  context_bundle, created_at, updated_at
      `,
      [
        id,
        input.source,
        input.title.trim(),
        nullable(input.operatorComment),
        nullable(input.runId),
        nullable(input.spanId),
        nullable(input.toolName),
        nullable(input.toolVersion),
        artifactIds,
        sanitizedContext,
        now,
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<ToolInvestigationRecord | undefined> {
    const rows = await this.pool.query<ToolInvestigationRow>(
      `
        select id, status, source, title, operator_comment, run_id, span_id,
               tool_name, tool_version, artifact_ids, linked_build_request_id,
               context_bundle, created_at, updated_at
        from tool_investigations
        where id = $1
      `,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async list(limit = 200): Promise<ToolInvestigationRecord[]> {
    const rows = await this.pool.query<ToolInvestigationRow>(
      `
        select id, status, source, title, operator_comment, run_id, span_id,
               tool_name, tool_version, artifact_ids, linked_build_request_id,
               context_bundle, created_at, updated_at
        from tool_investigations
        order by created_at desc
        limit $1
      `,
      [limit],
    );
    return rows.rows.map(mapRow);
  }

  async update(id: string, update: ToolInvestigationUpdateInput): Promise<ToolInvestigationRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Tool investigation ${id} was not found`);

    const status = update.status ?? existing.status;
    const operatorComment =
      update.operatorComment === undefined ? existing.operatorComment : nullable(update.operatorComment);
    const linkedBuildRequestId =
      update.linkedBuildRequestId === undefined
        ? existing.linkedBuildRequestId ?? null
        : update.linkedBuildRequestId === null
          ? null
          : nullable(update.linkedBuildRequestId);
    const artifactIds = update.artifactIds ? uniqueStringArray(update.artifactIds) : existing.artifactIds;
    const contextBundle = update.contextBundle ? sanitizeContextBundle(update.contextBundle) : existing.contextBundle;
    const now = new Date().toISOString();

    const rows = await this.pool.query<ToolInvestigationRow>(
      `
        update tool_investigations
        set status = $2,
            operator_comment = $3,
            linked_build_request_id = $4,
            artifact_ids = $5,
            context_bundle = $6,
            updated_at = $7
        where id = $1
        returning id, status, source, title, operator_comment, run_id, span_id,
                  tool_name, tool_version, artifact_ids, linked_build_request_id,
                  context_bundle, created_at, updated_at
      `,
      [id, status, operatorComment, linkedBuildRequestId, artifactIds, contextBundle, now],
    );

    if (!rows.rows[0]) throw new Error(`Tool investigation ${id} was not found`);
    return mapRow(rows.rows[0]);
  }
}

function mapRow(row: ToolInvestigationRow | undefined): ToolInvestigationRecord {
  if (!row) throw new Error("Tool investigation insert did not return a row");
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    title: row.title,
    operatorComment: row.operator_comment ?? undefined,
    runId: row.run_id ?? undefined,
    spanId: row.span_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolVersion: row.tool_version ?? undefined,
    artifactIds: row.artifact_ids ?? [],
    linkedBuildRequestId: row.linked_build_request_id ?? undefined,
    contextBundle: row.context_bundle ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function nullable(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
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
