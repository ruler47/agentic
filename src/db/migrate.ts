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
