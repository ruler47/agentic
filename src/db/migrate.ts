import { createPool } from "./pool.js";

export async function migrate(connectionString = process.env.DATABASE_URL): Promise<void> {
  const pool = createPool(connectionString);

  try {
    await pool.query(`
      create table if not exists instance_settings (
        id text primary key,
        name text not null,
        default_language text not null,
        time_zone text not null,
        locale text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      insert into instance_settings (id, name, default_language, time_zone, locale, created_at, updated_at)
      values ('instance-local', 'Local Agentic Assistant', 'ru', 'Europe/Madrid', 'ru-RU', now(), now())
      on conflict (id) do nothing;
    `);

    await pool.query(`
      create table if not exists group_profile (
        id text primary key,
        instance_id text not null references instance_settings(id) on delete cascade,
        name text not null,
        description text not null default '',
        preferences jsonb not null default '{}',
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      insert into group_profile (id, instance_id, name, description, created_at, updated_at)
      values (
        'group-local',
        'instance-local',
        'Local Group Profile',
        'Default one-group profile for local development.',
        now(),
        now()
      )
      on conflict (id) do nothing;
    `);

    await pool.query(`
      create table if not exists users (
        id text primary key,
        display_name text not null,
        role text not null default 'admin',
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      insert into users (id, display_name, role, created_at, updated_at)
      values ('user-admin', 'Local Admin', 'admin', now(), now())
      on conflict (id) do nothing;
    `);

    await pool.query(`
      create table if not exists user_roles (
        user_id text not null references users(id) on delete cascade,
        role text not null,
        created_at timestamptz not null,
        primary key (user_id, role)
      );
    `);

    await pool.query(`
      insert into user_roles (user_id, role, created_at)
      values ('user-admin', 'admin', now())
      on conflict (user_id, role) do nothing;
    `);

    await pool.query(`
      create table if not exists channel_identities (
        id text primary key,
        provider text not null,
        provider_user_id text not null,
        user_id text not null references users(id) on delete cascade,
        allow_status text not null check (allow_status in ('allowed', 'blocked')),
        display_metadata jsonb not null default '{}',
        last_seen_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (provider, provider_user_id)
      );
    `);

    await pool.query(`
      create table if not exists conversation_threads (
        id text primary key,
        status text not null check (status in ('active', 'archived')),
        title text not null,
        requester_user_id text not null references users(id) on delete restrict,
        channel text not null,
        source_chat_id text,
        source_thread_id text,
        latest_run_id text,
        summary text not null,
        accepted_facts text[] not null default '{}',
        rejected_attempts text[] not null default '{}',
        open_questions text[] not null default '{}',
        artifact_ids text[] not null default '{}',
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists conversation_threads_updated_at_idx
      on conversation_threads(updated_at desc);
    `);

    await pool.query(`
      create table if not exists thread_messages (
        id text primary key,
        thread_id text not null references conversation_threads(id) on delete cascade,
        run_id text,
        parent_run_id text,
        role text not null check (role in ('user', 'assistant', 'system')),
        content text not null,
        source_message_id text,
        created_at timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists thread_messages_thread_created_at_idx
      on thread_messages(thread_id, created_at asc);
    `);

    await pool.query(`
      create table if not exists runs (
        id text primary key,
        task text not null,
        status text not null check (status in ('queued', 'running', 'completed', 'failed')),
        instance_id text,
        requester_user_id text,
        channel text,
        thread_id text,
        parent_run_id text,
        source_message_id text,
        source_chat_id text,
        source_thread_id text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        result jsonb,
        error text
      );
    `);

    await pool.query(`alter table runs add column if not exists instance_id text;`);
    await pool.query(`alter table runs add column if not exists requester_user_id text;`);
    await pool.query(`alter table runs add column if not exists channel text;`);
    await pool.query(`alter table runs add column if not exists thread_id text;`);
    await pool.query(`alter table runs add column if not exists parent_run_id text;`);
    await pool.query(`alter table runs add column if not exists source_message_id text;`);
    await pool.query(`alter table runs add column if not exists source_chat_id text;`);
    await pool.query(`alter table runs add column if not exists source_thread_id text;`);

    await pool.query(`
      create index if not exists runs_thread_id_created_at_idx
      on runs(thread_id, created_at desc);
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
      create table if not exists audit_events (
        id text primary key,
        instance_id text not null,
        actor_id text not null,
        actor_type text not null check (actor_type in ('user', 'agent', 'system', 'tool')),
        action text not null,
        target_type text not null,
        target_id text not null,
        status text not null check (status in ('success', 'failure', 'pending')),
        run_id text,
        thread_id text,
        requester_user_id text,
        channel text,
        summary text not null,
        metadata jsonb,
        created_at timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists audit_events_created_at_idx
      on audit_events(created_at desc);
    `);

    await pool.query(`
      create index if not exists audit_events_run_id_idx
      on audit_events(run_id, created_at desc);
    `);

    await pool.query(`
      create index if not exists audit_events_action_status_idx
      on audit_events(action, status, created_at desc);
    `);

    await pool.query(`
      create table if not exists artifacts (
        id text primary key,
        run_id text not null references runs(id) on delete cascade,
        kind text not null check (kind in ('input', 'output')),
        filename text not null,
        mime_type text not null,
        size_bytes bigint not null check (size_bytes >= 0),
        url text not null,
        description text,
        content_preview text,
        storage_provider text not null,
        object_key text not null,
        checksum_sha256 text not null,
        created_at timestamptz not null
      );
    `);

    await pool.query(`
      create index if not exists artifacts_run_id_created_at_idx
      on artifacts(run_id, created_at asc);
    `);

    await pool.query(`
      create unique index if not exists artifacts_storage_provider_object_key_idx
      on artifacts(storage_provider, object_key);
    `);

    await pool.query(`
      create table if not exists skill_memories (
        id text primary key,
        title text not null,
        tags text[] not null default '{}',
        summary text not null,
        reusable_procedure text not null,
        scope text not null default 'global' check (scope in ('global', 'group', 'user', 'thread', 'run')),
        scope_id text,
        status text not null default 'accepted' check (status in ('proposed', 'accepted', 'rejected', 'archived')),
        confidence double precision not null default 0.75 check (confidence >= 0 and confidence <= 1),
        sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'private')),
        source_run_id text,
        source_thread_id text,
        evidence text[] not null default '{}',
        created_at timestamptz not null,
        updated_at timestamptz not null default now(),
        search_document tsvector not null
      );
    `);

    await pool.query(`alter table skill_memories add column if not exists scope text not null default 'global';`);
    await pool.query(`alter table skill_memories add column if not exists scope_id text;`);
    await pool.query(`alter table skill_memories add column if not exists status text not null default 'accepted';`);
    await pool.query(`alter table skill_memories add column if not exists confidence double precision not null default 0.75;`);
    await pool.query(`alter table skill_memories add column if not exists sensitivity text not null default 'normal';`);
    await pool.query(`alter table skill_memories add column if not exists source_run_id text;`);
    await pool.query(`alter table skill_memories add column if not exists source_thread_id text;`);
    await pool.query(`alter table skill_memories add column if not exists evidence text[] not null default '{}';`);
    await pool.query(`alter table skill_memories add column if not exists updated_at timestamptz not null default now();`);

    await pool.query(`
      create index if not exists skill_memories_search_document_idx
      on skill_memories using gin(search_document);
    `);

    await pool.query(`
      create index if not exists skill_memories_created_at_idx
      on skill_memories(created_at desc);
    `);

    await pool.query(`
      create index if not exists skill_memories_scope_status_idx
      on skill_memories(scope, scope_id, status, updated_at desc);
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
        rework_of text,
        feedback text,
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
    await pool.query(`alter table tool_build_requests add column if not exists rework_of text;`);
    await pool.query(`alter table tool_build_requests add column if not exists feedback text;`);

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
