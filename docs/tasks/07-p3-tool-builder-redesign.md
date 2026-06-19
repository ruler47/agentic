# P3 Tool Builder Redesign

## BA View

### Problem

The old builder became too complex and unreliable before the base runtime was stable.
The product still needs a builder eventually, but it must be redesigned around the same
portable tool contract as the core toolbelt.

### Desired Behavior

The user should be able to request a capability:

"Here is API documentation and credentials. Create a tool that checks crypto AML risk."

The platform should:

- preserve docs/files/URLs/credential handles as tool context;
- choose implementation strategy dynamically;
- create an out-of-tree package/service;
- run package-local build/test/QA;
- register a versioned manifest;
- keep it disabled until verification unless policy says otherwise;
- promote/rollback versions through explicit evidence.

### User Stories

- As a user, I can create a tool from docs/files and optional API keys.
- As an operator, I can review package source, schemas, QA evidence, secrets, health, and
  version history.
- As an agent, I can request a missing capability only after the builder lifecycle is
  stable.

### Non-Goals

- Do not generate code directly into tracked Agentic app source.
- Do not silently create tools during ordinary runs in the current phase.
- Do not create task-specific hardcoded tools.

## Architect / Tech Lead View

### Proposed Solution

Redesign builder as a separate product layer over the tool package contract.

Input contract:

- capability name and description;
- user task/request;
- docs URLs;
- uploaded files;
- credentials as secret handles;
- startup mode: on-demand or always-on;
- desired QA examples or auto-generated QA policy;
- package constraints and allowed dependencies.

Output contract:

- `tool.package.json` manifest;
- schemas;
- README/docs;
- package source outside Agentic tracked source;
- Dockerfile or local HTTP runtime;
- build/test results;
- behavior QA evidence;
- health result;
- version metadata.

Builder lifecycle:

1. Intake and context normalization.
2. Strategy selection: npm wrapper, HTTP/API client, browser automation, CLI wrapper,
   custom TypeScript, service adapter, or combined strategy.
3. Source generation in out-of-tree workspace.
4. Static safety review and secret scan.
5. Package build/test.
6. Behavior QA and fixture generation.
7. Register disabled candidate.
8. Manual or policy-based promotion.
9. Runtime reload/restart.

### Likely Files

- `src/tools/toolBuilderAgent.ts`
- `src/tools/toolCreationV1*.ts`
- `src/tools/toolPackageRunner*.ts`
- `src/tools/toolIntegrationContract.ts`
- `src/server/modules/tools/*`
- `web-react/src/routes/Tools.tsx`
- `docs/architecture/tool-build-council.md`
- future new builder docs under `docs/tasks` or `docs/architecture`

## QA View

### Acceptance Criteria

- Builder accepts docs/files/URLs and stores context per tool family.
- Credentials are stored as secret handles and never appear in traces/source/artifacts.
- Generated package is outside tracked app source.
- Package exposes `/health` and `/run` or equivalent runner contract.
- Build/test/QA failures block promotion.
- Manual activation requires successful evidence for that exact version.
- Agent prompt sees only promoted available versions.

### Automated Tests

- Secret extraction/redaction.
- Package manifest validation.
- Package build/test failure blocks registration/promotion.
- Disabled candidate excluded from agent catalog.
- Version activation requires pinned evidence.
- Import/export preserves manifest/context.

### Manual Verification

1. Create a simple API-client tool from public docs.
2. Create a tool with a credential handle.
3. Verify source lives outside app code.
4. Run package QA.
5. Manually run candidate.
6. Promote and confirm agent can use it.
7. Roll back to previous version.

## PM / Feature Owner View

### Delivery Plan

1. Freeze current builder behavior except critical bug fixes.
2. Document the new builder contract.
3. Define package manifest validation gates.
4. Build intake/context UI.
5. Implement strategy selection as an auditable builder plan.
6. Implement package authoring in out-of-tree workspace.
7. Add QA fixtures and promotion gates.
8. Add import/export and rollback tests.
9. Re-enable agent-requested missing capability only after manual builder flow passes.

### Done When

- Builder creates portable tools from docs without changing Agentic app source.
- Operators can trust version activation evidence.
- Agents can eventually request tools through a safe explicit capability-gap flow.
