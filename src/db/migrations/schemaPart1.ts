import type { MigrationStatement } from "./migrationStatementRunner.js";

export const MIGRATION_STATEMENTS_PART_1: MigrationStatement[] = [
  {
    sql: "create extension if not exists vector;",
    warningPrefix: "pgvector extension is unavailable; semantic memory search will stay lexical: ",
  },
  {
    sql: "\n      create table if not exists instance_settings (\n        id text primary key,\n        name text not null,\n        default_language text not null,\n        time_zone text not null,\n        locale text not null,\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      insert into instance_settings (id, name, default_language, time_zone, locale, created_at, updated_at)\n      values ('instance-local', 'Local Agentic Assistant', 'ru', 'Europe/Madrid', 'ru-RU', now(), now())\n      on conflict (id) do nothing;\n    ",
  },
  {
    sql: "\n      create table if not exists group_profile (\n        id text primary key,\n        instance_id text not null references instance_settings(id) on delete cascade,\n        name text not null,\n        description text not null default '',\n        preferences jsonb not null default '{}',\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      insert into group_profile (id, instance_id, name, description, created_at, updated_at)\n      values (\n        'group-local',\n        'instance-local',\n        'Local Group Profile',\n        'Default one-group profile for local development.',\n        now(),\n        now()\n      )\n      on conflict (id) do nothing;\n    ",
  },
  {
    sql: "\n      create table if not exists users (\n        id text primary key,\n        display_name text not null,\n        role text not null default 'admin',\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      insert into users (id, display_name, role, created_at, updated_at)\n      values ('user-admin', 'Local Admin', 'admin', now(), now())\n      on conflict (id) do nothing;\n    ",
  },
  {
    sql: "\n      create table if not exists user_roles (\n        user_id text not null references users(id) on delete cascade,\n        role text not null,\n        created_at timestamptz not null,\n        primary key (user_id, role)\n      );\n    ",
  },
  {
    sql: "\n      insert into user_roles (user_id, role, created_at)\n      values ('user-admin', 'admin', now())\n      on conflict (user_id, role) do nothing;\n    ",
  },
  {
    sql: "\n      create table if not exists channel_identities (\n        id text primary key,\n        provider text not null,\n        provider_user_id text not null,\n        user_id text not null references users(id) on delete cascade,\n        allow_status text not null check (allow_status in ('allowed', 'blocked')),\n        display_metadata jsonb not null default '{}',\n        last_seen_at timestamptz,\n        created_at timestamptz not null,\n        updated_at timestamptz not null,\n        unique (provider, provider_user_id)\n      );\n    ",
  },
  {
    sql: "\n      create table if not exists conversation_threads (\n        id text primary key,\n        status text not null check (status in ('active', 'archived')),\n        title text not null,\n        requester_user_id text not null references users(id) on delete restrict,\n        channel text not null,\n        source_chat_id text,\n        source_thread_id text,\n        latest_run_id text,\n        summary text not null,\n        accepted_facts text[] not null default '{}',\n        rejected_attempts text[] not null default '{}',\n        open_questions text[] not null default '{}',\n        artifact_ids text[] not null default '{}',\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists conversation_threads_updated_at_idx\n      on conversation_threads(updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists thread_messages (\n        id text primary key,\n        thread_id text not null references conversation_threads(id) on delete cascade,\n        run_id text,\n        parent_run_id text,\n        role text not null check (role in ('user', 'assistant', 'system')),\n        content text not null,\n        source_message_id text,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists thread_messages_thread_created_at_idx\n      on thread_messages(thread_id, created_at asc);\n    ",
  },
  {
    sql: "\n      create table if not exists runs (\n        id text primary key,\n        task text not null,\n        status text not null check (status in ('queued', 'running', 'completed', 'failed')),\n        instance_id text,\n        requester_user_id text,\n        channel text,\n        thread_id text,\n        parent_run_id text,\n        source_user_id text,\n        source_message_id text,\n        source_chat_id text,\n        source_thread_id text,\n        created_at timestamptz not null,\n        updated_at timestamptz not null,\n        result jsonb,\n        error text\n      );\n    ",
  },
  {
    sql: "alter table runs add column if not exists instance_id text;",
  },
  {
    sql: "alter table runs add column if not exists requester_user_id text;",
  },
  {
    sql: "alter table runs add column if not exists channel text;",
  },
  {
    sql: "alter table runs add column if not exists thread_id text;",
  },
  {
    sql: "alter table runs add column if not exists parent_run_id text;",
  },
  {
    sql: "alter table runs add column if not exists source_user_id text;",
  },
  {
    sql: "alter table runs add column if not exists source_message_id text;",
  },
  {
    sql: "alter table runs add column if not exists source_chat_id text;",
  },
  {
    sql: "alter table runs add column if not exists source_thread_id text;",
  },
  {
    sql: "\n      update runs\n      set status = 'failed',\n          error = coalesce(error, 'Legacy tool rework wait status was removed during base rebuild.')\n      where status = 'waiting_tool_rework';\n    ",
  },
  {
    sql: "\n      alter table runs drop constraint if exists runs_status_check;\n      alter table runs add constraint runs_status_check\n        check (status in ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'));\n    ",
  },
  {
    sql: "\n      alter table runs drop constraint if exists runs_status_check;\n      alter table runs add constraint runs_status_check\n        check (status in ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'));\n    ",
  },
  {
    sql: "\n      create index if not exists runs_thread_id_created_at_idx\n      on runs(thread_id, created_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists run_events (\n        id text primary key,\n        run_id text not null references runs(id) on delete cascade,\n        span_id text not null,\n        parent_span_id text,\n        type text not null,\n        actor text not null,\n        activity text not null,\n        status text not null,\n        title text not null,\n        detail text,\n        timestamp timestamptz not null,\n        started_at timestamptz,\n        completed_at timestamptz,\n        duration_ms integer,\n        payload jsonb,\n        sequence bigserial not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists run_events_run_id_sequence_idx\n      on run_events(run_id, sequence);\n    ",
  },
  {
    sql: "\n      create index if not exists runs_created_at_idx\n      on runs(created_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists audit_events (\n        id text primary key,\n        instance_id text not null,\n        actor_id text not null,\n        actor_type text not null check (actor_type in ('user', 'agent', 'system', 'tool')),\n        action text not null,\n        target_type text not null,\n        target_id text not null,\n        status text not null check (status in ('success', 'failure', 'pending')),\n        run_id text,\n        thread_id text,\n        requester_user_id text,\n        channel text,\n        summary text not null,\n        metadata jsonb,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists audit_events_created_at_idx\n      on audit_events(created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists audit_events_run_id_idx\n      on audit_events(run_id, created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists audit_events_action_status_idx\n      on audit_events(action, status, created_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists artifacts (\n        id text primary key,\n        run_id text not null references runs(id) on delete cascade,\n        kind text not null check (kind in ('input', 'output')),\n        filename text not null,\n        mime_type text not null,\n        size_bytes bigint not null check (size_bytes >= 0),\n        url text not null,\n        description text,\n        content_preview text,\n        quality jsonb,\n        storage_provider text not null,\n        object_key text not null,\n        checksum_sha256 text not null,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      alter table artifacts\n      add column if not exists quality jsonb;\n    ",
  },
  {
    sql: "\n      create index if not exists artifacts_run_id_created_at_idx\n      on artifacts(run_id, created_at asc);\n    ",
  },
  {
    sql: "\n      create unique index if not exists artifacts_storage_provider_object_key_idx\n      on artifacts(storage_provider, object_key);\n    ",
  },
  {
    sql: "\n      create table if not exists skill_memories (\n        id text primary key,\n        title text not null,\n        tags text[] not null default '{}',\n        summary text not null,\n        reusable_procedure text not null,\n        scope text not null default 'global' check (scope in ('global', 'group', 'user', 'thread', 'run')),\n        scope_id text,\n        status text not null default 'accepted' check (status in ('proposed', 'accepted', 'rejected', 'archived')),\n        confidence double precision not null default 0.75 check (confidence >= 0 and confidence <= 1),\n        sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'private')),\n        source_run_id text,\n        source_thread_id text,\n        evidence text[] not null default '{}',\n        created_at timestamptz not null,\n        updated_at timestamptz not null default now(),\n        search_document tsvector not null\n      );\n    ",
  },
  {
    sql: "alter table skill_memories add column if not exists scope text not null default 'global';",
  },
  {
    sql: "alter table skill_memories add column if not exists scope_id text;",
  },
  {
    sql: "alter table skill_memories add column if not exists status text not null default 'accepted';",
  }
];
