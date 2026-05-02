import { createPool } from "./pool.js";

export async function migrate(connectionString = process.env.DATABASE_URL): Promise<void> {
  const pool = createPool(connectionString);

  try {
    await pool.query(`
      create table if not exists runs (
        id text primary key,
        task text not null,
        status text not null check (status in ('queued', 'running', 'completed', 'failed')),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        result jsonb,
        error text
      );
    `);

    await pool.query(`
      create table if not exists run_events (
        id text primary key,
        run_id text not null references runs(id) on delete cascade,
        span_id text not null,
        parent_span_id text,
        type text not null,
        actor text not null,
        activity text not null,
        status text not null,
        title text not null,
        detail text,
        timestamp timestamptz not null,
        started_at timestamptz,
        completed_at timestamptz,
        duration_ms integer,
        payload jsonb,
        sequence bigserial not null
      );
    `);

    await pool.query(`
      create index if not exists run_events_run_id_sequence_idx
      on run_events(run_id, sequence);
    `);

    await pool.query(`
      create index if not exists runs_created_at_idx
      on runs(created_at desc);
    `);

    await pool.query(`
      create table if not exists skill_memories (
        id text primary key,
        title text not null,
        tags text[] not null default '{}',
        summary text not null,
        reusable_procedure text not null,
        created_at timestamptz not null,
        search_document tsvector not null
      );
    `);

    await pool.query(`
      create index if not exists skill_memories_search_document_idx
      on skill_memories using gin(search_document);
    `);

    await pool.query(`
      create index if not exists skill_memories_created_at_idx
      on skill_memories(created_at desc);
    `);

    await pool.query(`
      create table if not exists model_tier_settings (
        tier text primary key check (tier in ('S', 'M', 'L', 'XL')),
        models text[] not null default '{}',
        max_attempts integer not null default 2 check (max_attempts >= 1 and max_attempts <= 5),
        escalate_on_failure boolean not null default true,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      create table if not exists tool_modules (
        name text primary key,
        version text not null,
        description text not null,
        capabilities text[] not null default '{}',
        startup_mode text not null check (startup_mode in ('always-on', 'on-demand', 'ephemeral')),
        input_schema jsonb,
        output_schema jsonb,
        module_path text,
        test_path text,
        source text not null check (source in ('builtin', 'generated')),
        status text not null check (status in ('available', 'disabled', 'failed')),
        last_health_ok boolean,
        last_health_detail text,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists tool_modules_capabilities_idx
      on tool_modules using gin(capabilities);
    `);

    await pool.query(`alter table tool_modules add column if not exists module_path text;`);
    await pool.query(`alter table tool_modules add column if not exists test_path text;`);

    await pool.query(`
      create table if not exists tool_build_requests (
        id text primary key,
        capability text not null,
        reason text not null,
        source_run_id text references runs(id) on delete set null,
        source_span_id text,
        task_summary text,
        desired_tool_name text,
        required_inputs text[],
        required_outputs text[],
        qa_criteria text[],
        status text not null check (status in ('requested', 'building', 'qa_failed', 'qa_passed', 'registered', 'blocked')),
        status_detail text,
        qa_report jsonb,
        registered_tool_name text,
        contract jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`alter table tool_build_requests add column if not exists status_detail text;`);
    await pool.query(`alter table tool_build_requests add column if not exists qa_report jsonb;`);
    await pool.query(`alter table tool_build_requests add column if not exists registered_tool_name text;`);

    await pool.query(`
      create index if not exists tool_build_requests_capability_status_idx
      on tool_build_requests(capability, status, created_at desc);
    `);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
