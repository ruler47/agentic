import type { MigrationStatement } from "./migrationStatementRunner.js";

export const MIGRATION_STATEMENTS_PART_2: MigrationStatement[] = [
  {
    sql: "alter table skill_memories add column if not exists confidence double precision not null default 0.75;",
  },
  {
    sql: "alter table skill_memories add column if not exists sensitivity text not null default 'normal';",
  },
  {
    sql: "alter table skill_memories add column if not exists source_run_id text;",
  },
  {
    sql: "alter table skill_memories add column if not exists source_thread_id text;",
  },
  {
    sql: "alter table skill_memories add column if not exists evidence text[] not null default '{}';",
  },
  {
    sql: "alter table skill_memories add column if not exists updated_at timestamptz not null default now();",
  },
  {
    sql: "alter table skill_memories add column if not exists memory_embedding vector(128);",
    warningPrefix: "skill_memories.memory_embedding was not created; semantic memory search will stay lexical: ",
  },
  {
    sql: "\n      create index if not exists skill_memories_search_document_idx\n      on skill_memories using gin(search_document);\n    ",
  },
  {
    sql: "\n      create index if not exists skill_memories_created_at_idx\n      on skill_memories(created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists skill_memories_scope_status_idx\n      on skill_memories(scope, scope_id, status, updated_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists skill_memories_embedding_idx\n      on skill_memories using hnsw (memory_embedding vector_cosine_ops);\n    ",
    warningPrefix: "skill_memories_embedding_idx was not created; semantic memory search will stay lexical: ",
  },
  {
    sql: "\n      create table if not exists model_tier_settings (\n        tier text primary key check (tier in ('S', 'M', 'L', 'XL')),\n        models text[] not null default '{}',\n        max_attempts integer not null default 2 check (max_attempts >= 1 and max_attempts <= 5),\n        escalate_on_failure boolean not null default true,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create table if not exists model_providers (\n        id text primary key,\n        label text not null,\n        kind text not null check (kind in ('chat', 'embedding')),\n        provider_type text not null check (provider_type in ('local', 'remote', 'openai-compatible', 'deterministic')),\n        base_url text,\n        model_ids text[] not null default '{}',\n        default_model text,\n        api_key_secret_handle text,\n        dimensions integer,\n        status text not null check (status in ('available', 'loaded', 'disabled', 'failed')),\n        health_status text not null check (health_status in ('unknown', 'ok', 'failed')),\n        health_detail text,\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists model_providers_kind_status_idx\n      on model_providers(kind, status, updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_modules (\n        name text primary key,\n        display_name text,\n        version text not null,\n        description text not null,\n        capabilities text[] not null default '{}',\n        startup_mode text not null check (startup_mode in ('always-on', 'on-demand', 'ephemeral')),\n        input_schema jsonb,\n        output_schema jsonb,\n        module_path text,\n        test_path text,\n        source text not null check (source in ('builtin', 'generated')),\n        status text not null check (status in ('available', 'disabled', 'failed')),\n        last_health_ok boolean,\n        last_health_detail text,\n        required_configuration_keys text[] not null default '{}',\n        required_secret_handles text[] not null default '{}',\n        settings_schema jsonb,\n        storage_contract jsonb,\n        docs_markdown text,\n        change_summary text,\n        promotion_evidence jsonb,\n        examples jsonb not null default '[]',\n        package_manifest jsonb,\n        success_count integer not null default 0 check (success_count >= 0),\n        failure_count integer not null default 0 check (failure_count >= 0),\n        last_success_at timestamptz,\n        last_failure_at timestamptz,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_modules_capabilities_idx\n      on tool_modules using gin(capabilities);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_context_items (\n        id text primary key,\n        tool_name text not null,\n        kind text not null check (kind in ('documentation', 'api-docs', 'openapi', 'docs-url', 'file', 'note', 'qa-example')),\n        title text not null,\n        content text not null,\n        mime_type text,\n        source text,\n        created_at timestamptz not null,\n        updated_at timestamptz not null,\n        deleted_at timestamptz\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_context_items_tool_idx\n      on tool_context_items(tool_name, deleted_at, updated_at desc);\n    ",
  },
  {
    sql: "alter table tool_modules add column if not exists module_path text;",
  },
  {
    sql: "alter table tool_modules add column if not exists display_name text;",
  },
  {
    sql: "alter table tool_modules add column if not exists test_path text;",
  },
  {
    sql: "alter table tool_modules add column if not exists required_configuration_keys text[] not null default '{}';",
  },
  {
    sql: "alter table tool_modules add column if not exists required_secret_handles text[] not null default '{}';",
  },
  {
    sql: "alter table tool_modules add column if not exists settings_schema jsonb;",
  },
  {
    sql: "alter table tool_modules add column if not exists storage_contract jsonb;",
  },
  {
    sql: "alter table tool_modules add column if not exists docs_markdown text;",
  },
  {
    sql: "alter table tool_modules add column if not exists change_summary text;",
  },
  {
    sql: "alter table tool_modules add column if not exists promotion_evidence jsonb;",
  },
  {
    sql: "\n      update tool_modules\n      set change_summary = 'Generated tool metadata existed before changelog tracking; inspect docs, tests, and linked Tool Build requests for the original change context.'\n      where source = 'generated' and change_summary is null;\n    ",
  },
  {
    sql: "alter table tool_modules add column if not exists examples jsonb not null default '[]';",
  },
  {
    sql: "alter table tool_modules add column if not exists package_manifest jsonb;",
  },
  {
    sql: "alter table tool_modules add column if not exists success_count integer not null default 0;",
  },
  {
    sql: "alter table tool_modules add column if not exists failure_count integer not null default 0;",
  },
  {
    sql: "alter table tool_modules add column if not exists last_success_at timestamptz;",
  },
  {
    sql: "alter table tool_modules add column if not exists last_failure_at timestamptz;",
  },
  {
    sql: "\n      alter table tool_modules drop constraint if exists tool_modules_status_check;\n      alter table tool_modules add constraint tool_modules_status_check\n        check (status in ('available', 'loaded', 'disabled', 'failed'));\n    ",
  },
  {
    sql: "\n      create table if not exists tool_creations (\n        id text primary key,\n        status text not null check (status in ('requested', 'building', 'qa_failed', 'registered', 'failed')),\n        source text not null check (source in ('operator', 'import', 'agent')),\n        tool_name text not null,\n        tool_version text not null,\n        kind text not null,\n        request text,\n        description text,\n        capabilities text[] not null default '{}',\n        dependencies jsonb not null default '[]',\n        strategy_decision jsonb,\n        package_ref text,\n        manifest_path text,\n        files text[] not null default '{}',\n        qa_report jsonb,\n        error text,\n        run_id text,\n        created_at timestamptz not null,\n        updated_at timestamptz not null,\n        registered_at timestamptz\n      );\n    ",
  },
  {
    sql: "\n      do $$\n      begin\n        alter table tool_creations drop constraint if exists tool_creations_source_check;\n        alter table tool_creations\n          add constraint tool_creations_source_check\n          check (source in ('operator', 'import', 'agent'));\n      end $$;\n    ",
  },
  {
    sql: "alter table tool_creations add column if not exists strategy_decision jsonb;",
  },
  {
    sql: "alter table tool_creations add column if not exists run_id text;",
  },
  {
    sql: "\n      create index if not exists tool_creations_updated_at_idx\n      on tool_creations(updated_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists tool_creations_tool_idx\n      on tool_creations(tool_name, updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_runtime_settings (\n        tool_name text not null,\n        key text not null,\n        value text not null,\n        updated_at timestamptz not null,\n        primary key (tool_name, key)\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_runtime_settings_tool_name_idx\n      on tool_runtime_settings(tool_name, updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_service_statuses (\n        tool_name text primary key,\n        status text not null check (status in ('stopped', 'starting', 'running', 'failed')),\n        desired_state text not null check (desired_state in ('stopped', 'running')),\n        detail text not null,\n        last_health_ok boolean,\n        last_heartbeat_at timestamptz,\n        started_at timestamptz,\n        stopped_at timestamptz,\n        updated_at timestamptz not null,\n        restart_count integer not null default 0 check (restart_count >= 0)\n      );\n    ",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists consecutive_failure_count integer not null default 0 check (consecutive_failure_count >= 0);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists auto_restart_enabled boolean;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists max_auto_restarts integer check (max_auto_restarts >= 0);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists restart_backoff_ms integer check (restart_backoff_ms >= 0);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists restart_backoff_multiplier double precision check (restart_backoff_multiplier >= 1);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists restart_backoff_max_ms integer check (restart_backoff_max_ms >= 0);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists restart_backoff_jitter_ratio double precision check (restart_backoff_jitter_ratio >= 0 and restart_backoff_jitter_ratio <= 1);",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists restart_requires_approval boolean;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists next_restart_at timestamptz;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists pending_restart_approval boolean;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists last_failure_at timestamptz;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists last_restart_at timestamptz;",
  },
  {
    sql: "alter table tool_service_statuses add column if not exists last_restart_reason text;",
  },
  {
    sql: "\n      create index if not exists tool_service_statuses_status_idx\n      on tool_service_statuses(status, updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_service_logs (\n        id text primary key,\n        tool_name text not null,\n        level text not null check (level in ('info', 'warn', 'error')),\n        message text not null,\n        status text,\n        detail text,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_service_logs_tool_created_at_idx\n      on tool_service_logs(tool_name, created_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_service_events (\n        id text primary key,\n        tool_name text not null,\n        direction text not null check (direction in ('inbound', 'outbound', 'system')),\n        status text not null check (status in ('received', 'queued', 'sent', 'failed', 'ignored')),\n        summary text not null,\n        source_user_id text,\n        source_chat_id text,\n        source_message_id text,\n        thread_id text,\n        run_id text,\n        payload_json jsonb,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_service_events_tool_created_at_idx\n      on tool_service_events(tool_name, created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists tool_service_events_thread_created_at_idx\n      on tool_service_events(thread_id, created_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_module_versions (\n        name text not null,\n        version text not null,\n        active boolean not null default false,\n        display_name text,\n        description text not null,\n        capabilities text[] not null default '{}',\n        startup_mode text not null check (startup_mode in ('always-on', 'on-demand', 'ephemeral')),\n        input_schema jsonb,\n        output_schema jsonb,\n        module_path text,\n        test_path text,\n        source text not null check (source in ('generated')),\n        status text not null check (status in ('available', 'loaded', 'disabled', 'failed')),\n        last_health_ok boolean,\n        last_health_detail text,\n        required_configuration_keys text[] not null default '{}',\n        required_secret_handles text[] not null default '{}',\n        settings_schema jsonb,\n        storage_contract jsonb,\n        docs_markdown text,\n        change_summary text,\n        promotion_evidence jsonb,\n        examples jsonb not null default '[]',\n        package_manifest jsonb,\n        success_count integer not null default 0 check (success_count >= 0),\n        failure_count integer not null default 0 check (failure_count >= 0),\n        last_success_at timestamptz,\n        last_failure_at timestamptz,\n        updated_at timestamptz not null,\n        primary key (name, version)\n      );\n    ",
  },
  {
    sql: "alter table tool_module_versions add column if not exists change_summary text;",
  },
  {
    sql: "alter table tool_module_versions add column if not exists promotion_evidence jsonb;",
  },
  {
    sql: "alter table tool_module_versions add column if not exists package_manifest jsonb;",
  },
  {
    sql: "\n      alter table tool_module_versions drop constraint if exists tool_module_versions_status_check;\n      alter table tool_module_versions add constraint tool_module_versions_status_check\n        check (status in ('available', 'loaded', 'disabled', 'failed'));\n    ",
  },
  {
    sql: "\n      insert into tool_module_versions (\n        name, version, active, display_name, description, capabilities, startup_mode,\n        input_schema, output_schema, module_path, test_path, source, status,\n        last_health_ok, last_health_detail, required_configuration_keys,\n        required_secret_handles, settings_schema, storage_contract, docs_markdown,\n        change_summary, promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at, updated_at\n      )\n      select name, version, true, display_name, description, capabilities, startup_mode,\n             input_schema, output_schema, module_path, test_path, source, status,\n             last_health_ok, last_health_detail, required_configuration_keys,\n             required_secret_handles, settings_schema, storage_contract, docs_markdown,\n             change_summary, promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at, updated_at\n      from tool_modules\n      where source = 'generated'\n      on conflict (name, version) do nothing;\n    ",
  },
  {
    sql: "\n      update tool_module_versions\n      set change_summary = case\n        when active then 'Active generated version existed before changelog tracking; inspect docs, tests, and linked Tool Build requests for the original change context.'\n        else 'Historical generated version existed before changelog tracking; retained for rollback and comparison.'\n      end\n      where change_summary is null;\n    ",
  },
  {
    sql: "\n      delete from tool_module_versions\n      where name in ('generated.browser.screenshot.manual', 'generated.browser.screenshot.isolated')\n         or (\n           name = 'generated.browser.screenshot'\n           and source = 'generated'\n           and (\n             package_manifest is null\n             or module_path = 'src/tools/generated/browser-screenshotTool.ts'\n             or package_manifest #>> '{package,type}' = 'local-path'\n           )\n         );\n    ",
  },
  {
    sql: "\n      delete from tool_modules\n      where name in ('generated.browser.screenshot.manual', 'generated.browser.screenshot.isolated')\n         or (\n           name = 'generated.browser.screenshot'\n           and source = 'generated'\n           and (\n             package_manifest is null\n             or module_path = 'src/tools/generated/browser-screenshotTool.ts'\n             or package_manifest #>> '{package,type}' = 'local-path'\n           )\n         );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_module_versions_name_active_idx\n      on tool_module_versions(name, active);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_migrations (\n        id text primary key,\n        tool_name text not null,\n        tool_version text not null,\n        migration_id text not null,\n        checksum text not null,\n        status text not null check (status in ('pending', 'applied', 'failed', 'rolled_back')),\n        applied_at timestamptz,\n        applied_by_actor text,\n        qa_report jsonb,\n        rollback_notes text,\n        created_at timestamptz not null,\n        updated_at timestamptz not null,\n        unique (tool_name, tool_version, migration_id)\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_migrations_tool_status_idx\n      on tool_migrations(tool_name, status, updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists tool_promotions (\n        id text primary key,\n        tool_name text not null,\n        tool_version text not null,\n        status text not null check (status in ('promoted')),\n        promoted_at timestamptz not null,\n        build_request_id text,\n        qa_report jsonb,\n        package_ref text,\n        migration_ids text[] not null default '{}',\n        summary text not null,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists tool_promotions_tool_version_idx\n      on tool_promotions(tool_name, tool_version, promoted_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists tool_promotions_build_request_idx\n      on tool_promotions(build_request_id, promoted_at desc)\n      where build_request_id is not null;\n    ",
  },
  {
    sql: "\n      drop table if exists tool_rework_waits cascade;\n      drop table if exists tool_follow_ups cascade;\n      drop table if exists tool_build_requests cascade;\n    ",
  },
  {
    sql: "\n      create table if not exists secret_handles (\n        handle text primary key,\n        label text not null,\n        provider text not null check (provider in ('env', 'external', 'inline')),\n        secret_ref text not null,\n        scopes text[] not null default '{}',\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      alter table secret_handles\n      drop constraint if exists secret_handles_provider_check;\n    ",
  },
  {
    sql: "\n      alter table secret_handles\n      add constraint secret_handles_provider_check\n      check (provider in ('env', 'external', 'inline'));\n    ",
  },
  {
    sql: "\n      create index if not exists secret_handles_updated_at_idx\n      on secret_handles(updated_at desc);\n    ",
  },
  {
    sql: "\n      create table if not exists work_ledger_items (\n        id text primary key,\n        instance_id text,\n        thread_id text references conversation_threads(id) on delete set null,\n        run_id text references runs(id) on delete set null,\n        owner_span_id text,\n        parent_work_item_id text references work_ledger_items(id) on delete set null,\n        kind text not null check (kind in (\n          'search', 'url_visit', 'api_call', 'tool_call', 'screenshot',\n          'artifact_generation', 'data_fetch', 'analysis', 'other'\n        )),\n        status text not null check (status in (\n          'planned', 'claimed', 'running', 'completed', 'failed', 'stale', 'cancelled'\n        )),\n        work_key text not null,\n        title text not null,\n        summary text,\n        input_summary text,\n        output_summary text,\n        source_urls text[] not null default '{}',\n        artifact_ids text[] not null default '{}',\n        evidence_ids text[] not null default '{}',\n        error text,\n        confidence numeric,\n        freshness_expires_at timestamptz,\n        metadata jsonb not null default '{}'::jsonb,\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists work_ledger_items_thread_id_created_at_idx\n      on work_ledger_items(thread_id, created_at desc) where thread_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists work_ledger_items_run_id_created_at_idx\n      on work_ledger_items(run_id, created_at desc) where run_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists work_ledger_items_work_key_idx\n      on work_ledger_items(work_key, created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists work_ledger_items_status_idx\n      on work_ledger_items(status, created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists work_ledger_items_instance_id_idx\n      on work_ledger_items(instance_id, created_at desc) where instance_id is not null;\n    ",
  },
  {
    sql: "\n      create table if not exists evidence_ledger_records (\n        id text primary key,\n        instance_id text,\n        thread_id text references conversation_threads(id) on delete set null,\n        run_id text references runs(id) on delete set null,\n        span_id text,\n        work_item_id text references work_ledger_items(id) on delete set null,\n        kind text not null check (kind in (\n          'source_url', 'search_result', 'browser_snapshot', 'screenshot',\n          'api_response', 'artifact', 'file', 'model_observation', 'limitation', 'other'\n        )),\n        source_url text,\n        provider text,\n        tool_name text,\n        title text not null,\n        summary text,\n        content_preview text,\n        artifact_id text,\n        qa_status text not null check (qa_status in (\n          'unchecked', 'passed', 'failed', 'blocked', 'partial'\n        )),\n        confidence numeric,\n        limitations text[] not null default '{}',\n        metadata jsonb not null default '{}'::jsonb,\n        created_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      create index if not exists evidence_ledger_records_thread_id_created_at_idx\n      on evidence_ledger_records(thread_id, created_at desc) where thread_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists evidence_ledger_records_run_id_created_at_idx\n      on evidence_ledger_records(run_id, created_at desc) where run_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists evidence_ledger_records_work_item_id_created_at_idx\n      on evidence_ledger_records(work_item_id, created_at desc) where work_item_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists evidence_ledger_records_source_url_idx\n      on evidence_ledger_records(source_url) where source_url is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists evidence_ledger_records_artifact_id_idx\n      on evidence_ledger_records(artifact_id) where artifact_id is not null;\n    ",
  },
  {
    sql: "\n      create table if not exists run_retrospectives (\n        id text primary key,\n        instance_id text,\n        thread_id text references conversation_threads(id) on delete set null,\n        run_id text not null references runs(id) on delete cascade,\n        status text not null check (status in ('proposed', 'reviewed', 'archived')),\n        run_outcome text not null check (run_outcome in ('completed', 'failed', 'cancelled')),\n        what_worked text[] not null default '{}',\n        what_failed text[] not null default '{}',\n        suspected_root_causes text[] not null default '{}',\n        duplicated_work text[] not null default '{}',\n        weak_tools text[] not null default '{}',\n        weak_models text[] not null default '{}',\n        missing_capabilities text[] not null default '{}',\n        useful_evidence_ids text[] not null default '{}',\n        proposed_memory_ids text[] not null default '{}',\n        proposed_tool_follow_up_ids text[] not null default '{}',\n        proposed_policy_changes text[] not null default '{}',\n        proposed_prompt_changes text[] not null default '{}',\n        summary text,\n        metadata jsonb not null default '{}'::jsonb,\n        created_at timestamptz not null,\n        updated_at timestamptz not null\n      );\n    ",
  },
  {
    sql: "\n      alter table run_retrospectives\n        add column if not exists suspected_root_causes text[] not null default '{}',\n        add column if not exists duplicated_work text[] not null default '{}',\n        add column if not exists proposed_tool_follow_up_ids text[] not null default '{}',\n        add column if not exists proposed_policy_changes text[] not null default '{}',\n        add column if not exists proposed_prompt_changes text[] not null default '{}';\n    ",
  },
  {
    sql: "\n      create index if not exists run_retrospectives_run_id_created_at_idx\n      on run_retrospectives(run_id, created_at desc);\n    ",
  },
  {
    sql: "\n      create index if not exists run_retrospectives_thread_id_created_at_idx\n      on run_retrospectives(thread_id, created_at desc) where thread_id is not null;\n    ",
  },
  {
    sql: "\n      create index if not exists run_retrospectives_status_idx\n      on run_retrospectives(status, created_at desc);\n    ",
  },
  {
    sql: "drop table if exists coding_council_config cascade;",
  }
];
