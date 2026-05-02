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
  reason: string;
  source_run_id: string | null;
  source_span_id: string | null;
  task_summary: string | null;
  desired_tool_name: string | null;
  required_inputs: string[] | null;
  required_outputs: string[] | null;
  qa_criteria: string[] | null;
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
          id, capability, reason, source_run_id, source_span_id, task_summary,
          desired_tool_name, required_inputs, required_outputs, qa_criteria,
          status, contract, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'requested', $11, $12, $12)
        returning id, capability, reason, source_run_id, source_span_id, task_summary,
                  desired_tool_name, required_inputs, required_outputs, qa_criteria,
                  status, status_detail, qa_report, registered_tool_name,
                  contract, created_at, updated_at
      `,
      [
        id,
        input.capability,
        input.reason,
        input.sourceRunId ?? null,
        input.sourceSpanId ?? null,
        input.taskSummary ?? null,
        input.desiredToolName ?? null,
        input.requiredInputs ?? null,
        input.requiredOutputs ?? null,
        input.qaCriteria ?? null,
        contract,
        now,
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<ToolBuildRequest | undefined> {
    const rows = await this.pool.query<ToolBuildRequestRow>(
      `
        select id, capability, reason, source_run_id, source_span_id, task_summary,
               desired_tool_name, required_inputs, required_outputs, qa_criteria,
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
        select id, capability, reason, source_run_id, source_span_id, task_summary,
               desired_tool_name, required_inputs, required_outputs, qa_criteria,
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
        returning id, capability, reason, source_run_id, source_span_id, task_summary,
                  desired_tool_name, required_inputs, required_outputs, qa_criteria,
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
}

function mapRow(row: ToolBuildRequestRow | undefined): ToolBuildRequest {
  if (!row) {
    throw new Error("Tool build request insert did not return a row");
  }

  return {
    id: row.id,
    capability: row.capability,
    reason: row.reason,
    sourceRunId: row.source_run_id ?? undefined,
    sourceSpanId: row.source_span_id ?? undefined,
    taskSummary: row.task_summary ?? undefined,
    desiredToolName: row.desired_tool_name ?? undefined,
    requiredInputs: row.required_inputs ?? undefined,
    requiredOutputs: row.required_outputs ?? undefined,
    qaCriteria: row.qa_criteria ?? undefined,
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
