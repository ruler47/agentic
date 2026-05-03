import { PgPool } from "../db/pool.js";
import {
  createToolBuildContract,
  ToolBuildContract,
  ToolBuildQaReport,
  ToolBuildRequest,
  ToolBuildRequestInput,
  ToolBuildRequestStatusUpdate,
  ToolBuildRequestStatus,
  ToolBuildRequestStore,
} from "./toolBuildRequestStore.js";

type ToolBuildRequestRow = {
  id: string;
  capability: string;
  display_name: string | null;
  reason: string;
  source_run_id: string | null;
  source_span_id: string | null;
  task_summary: string | null;
  desired_tool_name: string | null;
  required_inputs: string[] | null;
  required_outputs: string[] | null;
  qa_criteria: string[] | null;
  credential_handles: string[] | null;
  credential_notes: string | null;
  rework_of: string | null;
  feedback: string | null;
  replaces_tool_name: string | null;
  replaces_version: string | null;
  status: ToolBuildRequestStatus;
  status_detail: string | null;
  qa_report: ToolBuildQaReport | null;
  registered_tool_name: string | null;
  contract: ToolBuildContract;
  created_at: Date;
  updated_at: Date;
};

export class PostgresToolBuildRequestStore implements ToolBuildRequestStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: ToolBuildRequestInput): Promise<ToolBuildRequest> {
    const now = new Date().toISOString();
    const id = `toolbuild_${Date.now()}_${slugify(input.capability).slice(0, 32)}_${Math.random().toString(36).slice(2, 8)}`;
    const contract = createToolBuildContract(input);

    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        insert into tool_build_requests (
          id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
          desired_tool_name, required_inputs, required_outputs, qa_criteria,
          credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
          status, contract, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'requested', $18, $19, $19)
        returning id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
                  desired_tool_name, required_inputs, required_outputs, qa_criteria,
                  credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
                  status, status_detail, qa_report, registered_tool_name,
                  contract, created_at, updated_at
      `,
      [
        id,
        input.capability,
        input.displayName ?? null,
        input.reason,
        input.sourceRunId ?? null,
        input.sourceSpanId ?? null,
        input.taskSummary ?? null,
        input.desiredToolName ?? null,
        input.requiredInputs ?? null,
        input.requiredOutputs ?? null,
        input.qaCriteria ?? null,
        input.credentialHandles ?? null,
        input.credentialNotes ?? null,
        input.reworkOf ?? null,
        input.feedback ?? null,
        input.replacesToolName ?? null,
        input.replacesVersion ?? null,
        contract,
        now,
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<ToolBuildRequest | undefined> {
    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        select id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
               desired_tool_name, required_inputs, required_outputs, qa_criteria,
               credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
               status, status_detail, qa_report, registered_tool_name,
               contract, created_at, updated_at
        from tool_build_requests
        where id = $1
      `,
      [id],
    );

    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async list(limit = 100): Promise<ToolBuildRequest[]> {
    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        select id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
               desired_tool_name, required_inputs, required_outputs, qa_criteria,
               credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
               status, status_detail, qa_report, registered_tool_name,
               contract, created_at, updated_at
        from tool_build_requests
        order by created_at desc
        limit $1
      `,
      [limit],
    );

    return rows.rows.map(mapRow);
  }

  async updateStatus(id: string, update: ToolBuildRequestStatusUpdate): Promise<ToolBuildRequest> {
    const now = new Date().toISOString();
    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        update tool_build_requests
        set status = $2,
            status_detail = $3,
            qa_report = $4,
            registered_tool_name = $5,
            updated_at = $6
        where id = $1
        returning id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
                  desired_tool_name, required_inputs, required_outputs, qa_criteria,
                  credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
                  status, status_detail, qa_report, registered_tool_name,
                  contract, created_at, updated_at
      `,
      [
        id,
        update.status,
        update.statusDetail ?? null,
        update.qaReport ?? null,
        update.registeredToolName ?? null,
        now,
      ],
    );

    if (!rows.rows[0]) {
      throw new Error(`Tool build request ${id} was not found`);
    }

    return mapRow(rows.rows[0]);
  }

  async claimNextRequested(statusDetail = "Claimed by Tool Builder worker."): Promise<ToolBuildRequest | undefined> {
    const now = new Date().toISOString();
    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        with next_request as (
          select id
          from tool_build_requests
          where status = 'requested'
          order by created_at asc
          for update skip locked
          limit 1
        )
        update tool_build_requests
        set status = 'building',
            status_detail = $1,
            updated_at = $2
        where id in (select id from next_request)
        returning id, capability, display_name, reason, source_run_id, source_span_id, task_summary,
                  desired_tool_name, required_inputs, required_outputs, qa_criteria,
                  credential_handles, credential_notes, rework_of, feedback, replaces_tool_name, replaces_version,
                  status, status_detail, qa_report, registered_tool_name,
                  contract, created_at, updated_at
      `,
      [statusDetail, now],
    );

    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from tool_build_requests where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

function mapRow(row: ToolBuildRequestRow | undefined): ToolBuildRequest {
  if (!row) {
    throw new Error("Tool build request insert did not return a row");
  }

  return {
    id: row.id,
    capability: row.capability,
    displayName: row.display_name ?? undefined,
    reason: row.reason,
    sourceRunId: row.source_run_id ?? undefined,
    sourceSpanId: row.source_span_id ?? undefined,
    taskSummary: row.task_summary ?? undefined,
    desiredToolName: row.desired_tool_name ?? undefined,
    requiredInputs: row.required_inputs ?? undefined,
    requiredOutputs: row.required_outputs ?? undefined,
    qaCriteria: row.qa_criteria ?? undefined,
    credentialHandles: row.credential_handles ?? undefined,
    credentialNotes: row.credential_notes ?? undefined,
    reworkOf: row.rework_of ?? undefined,
    feedback: row.feedback ?? undefined,
    replacesToolName: row.replaces_tool_name ?? undefined,
    replacesVersion: row.replaces_version ?? undefined,
    status: row.status,
    statusDetail: row.status_detail ?? undefined,
    qaReport: row.qa_report ?? undefined,
    registeredToolName: row.registered_tool_name ?? undefined,
    contract: row.contract,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "tool";
}
