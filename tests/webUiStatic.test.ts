import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web UI keeps page-based workspace information architecture", async () => {
  const [index, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(index, /<div id="app"><\/div>/);
  assert.match(index, /type="module" src="\/app\.js"/);

  for (const group of ["Work", "Analysis", "Build", "Control", "System"]) {
    assert.match(app, new RegExp(`group: "${group}"`));
  }

  for (const route of [
    "dashboard",
    "runs",
    "conversations",
    "trace",
    "memory",
    "artifacts",
    "tools",
    "tool-builds",
    "models",
    "group-profile",
    "approvals",
    "diagnostics",
  ]) {
    assert.match(app, new RegExp(`id: "${route}"|case "${route}"`));
  }

  assert.match(app, /traceMode: "timeline"/);
  assert.match(app, /traceGraphLayout: "category"/);
  assert.match(app, /"timeline", "graph", "logs"/);
  assert.match(app, /function renderGroupProfilePage/);
  assert.match(app, /function saveModelTiers/);
  assert.match(app, /\/api\/models\/catalog/);
  assert.match(app, /\/api\/model-providers/);
  assert.match(app, /Model Catalog/);
  assert.match(app, /Provider Registry/);
  assert.match(app, /data-action="create-model-provider"/);
  assert.match(app, /data-action="delete-model-provider"/);
  assert.match(app, /Local chat models/);
  assert.match(app, /Embedding/);
  assert.match(app, /data-action="create-tool-build-request"/);
  assert.match(app, /Request a Tool/);
  assert.match(app, /Tool name/);
  assert.match(app, /name="credentialNotes"/);
  assert.match(app, /The builder will derive the internal system name/);
  assert.match(app, /System name:/);
  assert.match(app, /data-action="delete-tool"/);
  assert.match(app, /\/api\/tools\/generated-modules\/\$\{encodeURIComponent\(toolName\)\}/);
  assert.match(app, /\/api\/tool-package-runners/);
  assert.match(app, /Package Runners/);
  assert.match(app, /data-action="reload-generated-tools"/);
  assert.match(app, /\/api\/tools\/reload-generated/);
  assert.match(app, /\/api\/secret-handles/);
  assert.match(app, /\/api\/tool-settings/);
  assert.match(app, /\/api\/tool-settings\/validate/);
  assert.match(app, /data-action="save-tool-settings"/);
  assert.match(app, /function saveToolRuntimeSettings/);
  assert.match(app, /function renderRuntimeSettingInput/);
  assert.match(app, /Runtime settings/);
  assert.match(app, /function createSecretHandle/);
  assert.match(app, /function deleteSecretHandle/);
  assert.match(app, /data-action="create-secret-handle"/);
  assert.match(app, /data-action="delete-secret-handle"/);
  assert.match(app, /credentialHandles/);
  assert.doesNotMatch(app, /Credential keys/);
  assert.doesNotMatch(app, /Existing credential handles/);
  assert.doesNotMatch(app, /Request a Capability/);
  assert.match(app, /data-live-run-duration/);
  assert.match(app, /function updateLiveTimers/);
  assert.match(app, /function cancelRun/);
  assert.match(app, /data-action="cancel-run"/);
  assert.match(app, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/cancel/);
  assert.match(app, /connectRunStream\(activeRun\(\)\?\.id\)/);
  assert.match(app, /class="ghost-button trace-back-button"/);
  assert.match(app, /data-action="select-run" data-run-id="\$\{run\.id\}"/);
  assert.match(app, /traceFilters:/);
  assert.match(app, /tool: "all"/);
  assert.match(app, /data-action="set-trace-filter"/);
  assert.match(app, /function applyTraceFilters/);
  assert.match(app, /function filterEventsForTrace/);
  assert.match(app, /function renderInspectorEvidence/);
  assert.match(app, /function renderInspectorCallFrame/);
  assert.match(app, /function renderInspectorSelfCheck/);
  assert.match(app, /Agent call frame/);
  assert.match(app, /Return self-check/);
  assert.match(app, /function renderTraceRunDirectory/);
  assert.match(app, /function renderTraceRunItem/);
  assert.match(app, /window\.location\.hash = normalized/);
  assert.match(app, /function drawGraphEdges/);
  assert.match(app, /function highlightGraphRelations/);
  assert.match(app, /data-action="set-trace-graph-layout"/);
  assert.match(app, /function traceGraphColumns/);
  assert.match(app, /function traceGraphDepths/);
  assert.match(app, /Call depth/);
  assert.match(app, /class="graph-edge/);
  assert.match(app, /groupBy\(orderedNodes/);
  assert.match(app, /graph-arrow-head-highlighted/);
  assert.match(app, /graph-arrow-head-failed/);
  assert.match(app, /failed-target/);
  assert.match(app, /function artifactPreview/);
  assert.match(app, /function renderArtifactQuality/);
  assert.match(app, /function renderDatasetPreview/);
  assert.match(app, /function artifactTypeLabel/);
  assert.match(styles, /\.artifact-table-preview/);
  assert.match(app, /data-default-marker="\$\{markerId\}"/);
  assert.match(app, /Dependency: waits for upstream result/);
  assert.match(app, /Calls a failed span/);
  assert.match(app, /function renderSpanToolRequestForm/);
  assert.match(app, /function renderInvestigationModal/);
  assert.match(app, /function buildSpanInvestigationDraft/);
  assert.match(app, /function createInvestigation/);
  assert.match(app, /function promoteInvestigationToBuild/);
  assert.match(app, /function renderToolInvestigationsSection/);
  assert.match(app, /function renderInvestigationCard/);
  assert.match(app, /data-action="open-investigation-modal"/);
  assert.match(app, /data-action="create-investigation"/);
  assert.match(app, /data-action="close-investigation-modal"/);
  assert.match(app, /data-action="promote-investigation-to-build"/);
  assert.match(app, /data-action="update-investigation-status"/);
  assert.match(app, /\/api\/tool-investigations/);
  assert.match(app, /Tool Investigation Ticket/);
  assert.match(app, /Tool Investigations/);
  assert.match(app, /function renderRunWaitPanel/);
  assert.match(app, /function renderRunWaitCard/);
  assert.match(app, /function renderInspectorReworkWait/);
  assert.match(app, /function renderInvestigationLinkedWaits/);
  assert.match(app, /function renderBuildLinkedWaits/);
  assert.match(app, /function resumeToolReworkWait/);
  assert.match(app, /function cancelToolReworkWait/);
  assert.match(app, /data-action="resume-tool-rework-wait"/);
  assert.match(app, /data-action="cancel-tool-rework-wait"/);
  assert.match(app, /\/api\/tool-rework-waits/);
  assert.match(app, /\/promote/);
  assert.match(app, /Waiting for tool upgrade/);
  assert.match(app, /Tool rework wait/);
  assert.match(app, /Mark ready for retry/);
  assert.doesNotMatch(
    app,
    />Resume run</,
    "the resume button must not be labelled 'Resume run' anymore — call it 'Mark ready for retry' instead",
  );
  // Auto retry-run skeleton: Run Workspace, Tool Builds, and Trace Lab inspector all
  // expose the new `/retry-run` action and surface the linked retryRunId once created.
  assert.match(app, /Create retry run/);
  assert.match(app, /data-action="create-retry-run-for-wait"/);
  assert.match(app, /function createRetryRunForWait/);
  assert.match(app, /\/api\/tool-rework-waits\/[^"]*\/retry-run/);
  assert.match(app, /Open retry run/);
  assert.match(app, /Retry run linked to a tool rework wait/);
  assert.match(app, /function renderRetryRunChip/);
  assert.match(app, /function isRetryRun/);
  assert.match(app, /function renderNotice/);
  assert.match(app, /sourceSpanId/);
  assert.match(app, /Tool request created/);
  assert.match(app, /navigate\("tool-builds"\)/);
  assert.match(app, /function renderMemoryDetail/);
  assert.match(app, /Known Limitations/);
  assert.match(app, /function isExternalBlockerMemory/);
  assert.match(app, /external blocker/);
  assert.match(styles, /\.knowledge-card\.limitation-memory/);
  assert.match(styles, /\.warning-chip/);
  assert.match(app, /\/api\/memories\/review-queue/);
  assert.match(app, /function renderMemoryProposalReview/);
  assert.match(app, /Blocked proposals/);
  assert.match(app, /function renderMemoryScopeSections/);
  assert.match(app, /function renderMemoryEditForm/);
  assert.match(app, /function saveMemory/);
  assert.match(app, /data-action="save-memory"/);
  assert.match(app, /data-action="set-memory-filter"/);
  assert.match(app, /memoryScopeTitle/);
  assert.match(app, /Retrieval impact/);
  assert.match(app, /Policy simulation/);
  assert.match(app, /function memoryPolicyDecision/);
  assert.match(app, /function currentMemoryPolicyContext/);
  assert.match(app, /data-action="rebuild-memory-embeddings"/);
  assert.match(app, /function rebuildMemoryEmbeddings/);
  assert.match(app, /function renderToolDetail/);
  assert.match(app, /function runToolHealthchecks/);
  assert.match(app, /data-action="run-tool-health"/);
  assert.match(app, /\/api\/tool-services/);
  assert.match(app, /\/api\/tool-services\/logs/);
  assert.match(app, /\/api\/tool-services\/logs\/events/);
  assert.match(app, /\/api\/tool-service-events/);
  assert.match(app, /function renderServiceCard/);
  assert.match(app, /function renderServiceRestartPolicyForm/);
  assert.match(app, /function renderApprovalCard/);
  assert.match(app, /function pendingApprovalItems/);
  assert.match(app, /Approve restart/);
  assert.match(app, /pendingRestartApproval/);
  assert.match(app, /restartBackoffMs/);
  assert.match(app, /restartBackoffMultiplier/);
  assert.match(app, /restartBackoffMaxMs/);
  assert.match(app, /restartBackoffJitterRatio/);
  assert.match(app, /restartRequiresApproval/);
  assert.match(app, /function formatFutureRelative/);
  assert.match(app, /function renderServiceLogPreview/);
  assert.match(app, /function renderServiceEventRow/);
  assert.match(app, /function updateToolService/);
  assert.match(app, /function updateToolServiceRestartPolicy/);
  assert.match(app, /\/api\/tool-services\/\$\{encodeURIComponent\(toolName\)\}\/restart-policy/);
  assert.match(app, /function connectServiceLogStream/);
  assert.match(app, /window\.setInterval\(\(\) => \{\s*void refreshData\(\{ soft: true \}\);/);
  assert.match(app, /function dataFingerprint/);
  assert.match(app, /function isUserEditing/);
  assert.match(app, /state\.pendingSoftRender/);
  assert.match(app, /tool-runtime-strip/);
  assert.match(app, /Always-on active/);
  assert.match(app, /function allowEventIdentity/);
  assert.match(app, /data-action="allow-event-identity"/);
  assert.match(app, /channel\.telegram\.bot/);
  assert.match(app, /data-action="tool-service-action"/);
  assert.match(app, /\/api\/tools\/health/);
  assert.match(app, /title: failed\.length \? "Tool healthchecks failed" : "Tool healthchecks passed"/);
  assert.match(app, /title: "Memory updated"/);
  assert.match(app, /function runToolBuild/);
  assert.match(app, /function reworkToolBuild/);
  assert.match(app, /function stopToolBuild/);
  assert.match(app, /function deleteToolBuild/);
  assert.match(app, /function deleteConversationThread/);
  assert.match(app, /function reworkTool/);
  assert.match(app, /function activateToolVersion/);
  assert.match(app, /function filterToolsForView/);
  assert.match(app, /function renderToolVersionPicker/);
  assert.match(app, /function formatToolPromotionEvidence/);
  assert.match(app, /function renderToolPromotionJournal/);
  assert.match(app, /function promotionJournalForTool/);
  assert.match(app, /function renderToolBuildQaEvidence/);
  assert.match(app, /function suggestToolBuildReworkPlaceholder/);
  assert.match(app, /Promotion evidence/);
  assert.match(app, /Promotion journal/);
  assert.match(app, /QA and activation checks/);
  assert.match(app, /rollback pass/);
  assert.match(app, /Current blocker:/);
  assert.match(app, /\/api\/tool-promotions/);
  assert.match(app, /function renderMarkdown/);
  assert.match(app, /function renderInlineMarkdown/);
  assert.match(app, /function normalizeInlineMath/);
  assert.match(app, /markdown-list/);
  assert.match(app, /data-action="rework-tool-build"/);
  assert.match(app, /data-action="rework-tool"/);
  assert.match(app, /data-action="search-tools"/);
  assert.match(app, /data-action="activate-tool-version"/);
  assert.match(app, /replacesVersion/);
  assert.match(app, /data-action="stop-tool-build"/);
  assert.match(app, /data-action="delete-tool-build"/);
  assert.match(app, /data-action="delete-thread"/);
  assert.match(app, /function renderMessageArtifacts/);
  assert.match(app, /function renderCompactArtifactLink/);
  assert.match(app, /inline-artifact-link/);
  assert.match(app, /data-action="run-tool-build"/);
  assert.match(app, /Self-service capability queue/);
  assert.match(app, /"Workers", "Tools"/);
  assert.match(app, /Memory hits/);
  assert.match(app, /Tool evidence/);
  assert.doesNotMatch(app, /id: "api-onboarding"/);
  assert.match(app, /fetch\("\/api\/runs"/);
  assert.match(app, /method: "POST"/);

  for (const componentClass of [
    ".app-shell",
    ".sidebar",
    ".top-header",
    ".hero-composer",
    ".run-workspace",
    ".trace-layout",
    ".trace-filters",
    ".promotion-evidence",
    ".promotion-journal-list",
    ".promotion-journal-entry",
    ".trace-run-item",
    ".graph-edge",
    ".graph-legend",
    ".trace-graph-layout-switch",
    ".graph-category-chip",
    ".graph-arrow-head-highlighted",
    ".graph-arrow-head-failed",
    ".graph-edge.failed-target",
    ".status-badge.cancelled",
    ".danger-button",
    ".artifact-preview",
    ".artifact-copy",
    ".artifact-quality",
    ".legend-line.dashed",
    ".notice-banner",
    ".inline-artifact-link",
    ".markdown-list",
    ".message-artifacts",
    ".memory-layout",
    ".memory-tabs",
    ".memory-scope-summary",
    ".memory-scope-section",
    ".proposal-review",
    ".memory-edit-form",
    ".tools-layout",
    ".tool-runtime-strip",
    ".tool-settings-summary",
    ".settings-schema-preview",
    ".helper-panel",
    ".model-catalog-grid",
    ".model-pill",
    ".kanban-heading",
    ".kanban-board",
    ".secret-handle-strip",
    ".empty-state",
    ".investigation-modal",
    ".investigation-modal-overlay",
    ".investigation-card",
    ".investigation-grid",
    ".span-investigation-actions",
    ".run-wait-panel",
    ".wait-card",
    ".rework-wait-card",
    ".retry-chip",
    ".row-title-text",
    ".status-badge.waiting_tool_rework",
  ]) {
    assert.match(styles, new RegExp(componentClass.replace(".", "\\.")));
  }

  assert.match(styles, /@keyframes skeleton/);
  assert.match(styles, /@keyframes running-pulse/);
  assert.match(styles, /\.run-status-bar h2\s*{[\s\S]*white-space: normal/);
  assert.match(styles, /\.inspector-panel\s*{[\s\S]*max-height: calc\(100vh - 112px\)/);
  assert.match(styles, /\.inspector-panel\s*{[\s\S]*overflow: auto/);
});
