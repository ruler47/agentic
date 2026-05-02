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
  assert.match(app, /"timeline", "graph", "logs"/);
  assert.match(app, /function renderGroupProfilePage/);
  assert.match(app, /function saveModelTiers/);
  assert.match(app, /data-action="create-tool-build-request"/);
  assert.match(app, /data-live-run-duration/);
  assert.match(app, /function updateLiveTimers/);
  assert.match(app, /connectRunStream\(activeRun\(\)\?\.id\)/);
  assert.match(app, /class="ghost-button trace-back-button"/);
  assert.match(app, /data-action="select-run" data-run-id="\$\{run\.id\}"/);
  assert.match(app, /traceFilters:/);
  assert.match(app, /tool: "all"/);
  assert.match(app, /data-action="set-trace-filter"/);
  assert.match(app, /function applyTraceFilters/);
  assert.match(app, /function filterEventsForTrace/);
  assert.match(app, /function renderInspectorEvidence/);
  assert.match(app, /function renderTraceRunDirectory/);
  assert.match(app, /function renderTraceRunItem/);
  assert.match(app, /window\.location\.hash = normalized/);
  assert.match(app, /function drawGraphEdges/);
  assert.match(app, /function highlightGraphRelations/);
  assert.match(app, /class="graph-edge/);
  assert.match(app, /groupBy\(orderTraceNodes\(nodes, false\)/);
  assert.match(app, /graph-arrow-head-highlighted/);
  assert.match(app, /graph-arrow-head-failed/);
  assert.match(app, /failed-target/);
  assert.match(app, /function artifactPreview/);
  assert.match(app, /data-default-marker="\$\{markerId\}"/);
  assert.match(app, /Dependency: waits for upstream result/);
  assert.match(app, /Calls a failed span/);
  assert.match(app, /function renderSpanToolRequestForm/);
  assert.match(app, /function inferCapabilityFromSpan/);
  assert.match(app, /sourceSpanId/);
  assert.match(app, /function renderMemoryDetail/);
  assert.match(app, /function renderToolDetail/);
  assert.match(app, /function runToolBuild/);
  assert.match(app, /function reworkToolBuild/);
  assert.match(app, /function stopToolBuild/);
  assert.match(app, /function deleteToolBuild/);
  assert.match(app, /function deleteConversationThread/);
  assert.match(app, /function reworkTool/);
  assert.match(app, /function renderMarkdown/);
  assert.match(app, /data-action="rework-tool-build"/);
  assert.match(app, /data-action="rework-tool"/);
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
    ".graph-arrow-head-highlighted",
    ".graph-arrow-head-failed",
    ".graph-edge.failed-target",
    ".artifact-preview",
    ".artifact-copy",
    ".legend-line.dashed",
    ".inline-artifact-link",
    ".message-artifacts",
    ".memory-layout",
    ".tools-layout",
    ".kanban-heading",
    ".kanban-board",
    ".empty-state",
  ]) {
    assert.match(styles, new RegExp(componentClass.replace(".", "\\.")));
  }

  assert.match(styles, /@keyframes skeleton/);
  assert.match(styles, /@keyframes running-pulse/);
});
