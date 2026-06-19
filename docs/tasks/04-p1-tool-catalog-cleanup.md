# P1 Tool Catalog Cleanup

## BA View

### Problem

The Tools UI and active registry can still show historical/generated/failed tools in ways
that make the product hard to understand. The user needs a stable view of the
preinstalled toolbelt first, while legacy/generated records remain inspectable without
polluting normal agent operation.

### Desired Behavior

- Core tools are the default visible toolbelt.
- Agents receive only active, available, enabled tools.
- Failed, disabled, rejected, historical, or missing-package generated tools are
  segregated into a secondary view.
- Operators can inspect old records, but they do not confuse the active system state.
- Tool metadata clearly states source, version, runner, health, enabled status, and
  availability to agents.

### User Stories

- As a user, I open Tools and immediately see the working core toolbelt.
- As an operator, I can filter legacy/generated tools without deleting history.
- As an agent runtime, I never receive disabled or broken tools in the prompt.

### Non-Goals

- Do not delete useful version history blindly.
- Do not remove registry/versioning machinery needed by the future builder.
- Do not reintroduce task-specific built-in tools.

## Architect / Tech Lead View

### Proposed Solution

Introduce explicit catalog layers:

- `core`: preinstalled first-party tools.
- `generated-active`: generated/imported tools currently available to agents.
- `generated-inactive`: disabled, failed, rejected, candidate, superseded.
- `legacy-reference`: retained historical modules not in active toolbelt.

Runtime policy:

- Agent catalog uses only tools where:
  - status is `available`;
  - enabled for agents;
  - runtime requirements resolve;
  - service health is acceptable for required startup mode.
- UI defaults to `core + generated-active`.
- UI provides "Inactive / historical" filters.
- Missing package/source conditions are explicit health states, not silent failures.

Implementation:

- Normalize catalog DTOs in server module.
- Add frontend filter tabs or segmented control.
- Add diagnostics for tools registered in metadata but missing implementation/package.
- Add tests that disabled/failed tools do not appear in agent prompt.

### Likely Files

- `src/server/modules/tools/*`
- `src/server/modules/runs/run-tool-catalog.ts`
- `src/tools/registry.ts`
- `web-react/src/routes/Tools.tsx`
- `web-react/src/routes/Diagnostics.tsx`
- tests for tool catalog filtering and run prompt eligibility

## QA View

### Acceptance Criteria

- `/api/tools` marks catalog layer/source/status consistently.
- Agent run context lists only eligible tools.
- Disabled/failed/missing generated tools are visible only in inactive/historical UI.
- Core tools appear first.
- Manual run remains possible for inactive tools when explicitly allowed.
- No old Tool Builder routes are restored.

### Automated Tests

- Disabled tool excluded from run tool catalog.
- Failed generated tool appears in admin catalog but not agent catalog.
- Core tools sort before generated active tools.
- Missing package health appears as degraded/failed with reason.

### Manual Verification

1. Open Tools page.
2. Confirm default view is understandable and core-first.
3. Toggle inactive/historical filters.
4. Start a run and inspect `agent-context-prepared` tool list.
5. Confirm disabled/failed tools are absent from the agent prompt.

## PM / Feature Owner View

### Delivery Plan

1. Inventory existing catalog DTO fields and UI assumptions.
2. Define catalog layer/status vocabulary.
3. Update server DTO normalization.
4. Update run tool eligibility filter tests.
5. Update Tools UI filters and labels.
6. Add diagnostics for missing package/source.
7. Manual UI smoke.
8. Update docs and close this task.

### Done When

- Tools page no longer looks like a pile of failed experiments.
- Agent prompt contains only usable tools.
- Legacy/generation history remains inspectable but not primary.
