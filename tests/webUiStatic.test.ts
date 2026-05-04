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
  assert.match(app, /\/api\/secret-handles/);
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
  assert.match(app, /function renderNotice/);
  assert.match(app, /function inferCapabilityFromSpan/);
  assert.match(app, /sourceSpanId/);
  assert.match(app, /Tool request created/);
  assert.match(app, /navigate\("tool-builds"\)/);
  assert.match(app, /function renderMemoryDetail/);
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
  assert.match(app, /function renderServiceCard/);
  assert.match(app, /function updateToolService/);
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
    ".model-catalog-grid",
    ".model-pill",
    ".kanban-heading",
    ".kanban-board",
    ".secret-handle-strip",
    ".empty-state",
  ]) {
    assert.match(styles, new RegExp(componentClass.replace(".", "\\.")));
  }

  assert.match(styles, /@keyframes skeleton/);
  assert.match(styles, /@keyframes running-pulse/);
  assert.match(styles, /\.span-request-box\[open\]/);
  assert.match(styles, /\.run-status-bar h2\s*{[\s\S]*white-space: normal/);
  assert.match(styles, /\.inspector-panel\s*{[\s\S]*max-height: calc\(100vh - 112px\)/);
  assert.match(styles, /\.inspector-panel\s*{[\s\S]*overflow: auto/);
});
