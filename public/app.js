const form = document.querySelector("#taskForm");
const taskInput = document.querySelector("#taskInput");
const fileInput = document.querySelector("#fileInput");
const submitButton = document.querySelector("#submitButton");
const refreshButton = document.querySelector("#refreshButton");
const answerOutput = document.querySelector("#answerOutput");
const eventList = document.querySelector("#eventList");
const runStatus = document.querySelector("#runStatus");
const runDuration = document.querySelector("#runDuration");
const activeRunLabel = document.querySelector("#activeRunLabel");
const connectionStatus = document.querySelector("#connectionStatus");
const inventorySummary = document.querySelector("#inventorySummary");
const toolList = document.querySelector("#toolList");
const memoryList = document.querySelector("#memoryList");
const toolBuildRequestList = document.querySelector("#toolBuildRequestList");
const runList = document.querySelector("#runList");
const modelTierList = document.querySelector("#modelTierList");
const saveModelTiersButton = document.querySelector("#saveModelTiersButton");
const attachmentList = document.querySelector("#attachmentList");
const artifactPanel = document.querySelector("#artifactPanel");
const artifactSummary = document.querySelector("#artifactSummary");
const artifactList = document.querySelector("#artifactList");

let activeRunId = null;
let currentRun = null;
let pollTimer = null;
let liveClockTimer = null;
let runStream = null;
let traceLayoutTimer = null;
let currentTraceNodes = [];

void loadInventory();
void loadRuns();
renderSelectedFiles();

saveModelTiersButton.addEventListener("click", () => {
  void saveModelTiers();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task) return;

  setBusy(true);
  answerOutput.textContent = "Starting agent run...";
  artifactList.replaceChildren();
  eventList.replaceChildren();
  eventList.dataset.signature = "";

  try {
    const attachments = await readSelectedFiles();
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, attachments }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "Failed to start run");
    }

    activeRunId = data.run.id;
    renderRun(data.run);
    void loadRuns();
    connectRunStream(data.run.id);
  } catch (error) {
    setBusy(false);
    connectionStatus.textContent = "Error";
    answerOutput.textContent = error instanceof Error ? error.message : String(error);
  }
});

fileInput.addEventListener("change", () => {
  renderSelectedFiles();
});

refreshButton.addEventListener("click", () => {
  if (activeRunId) {
    void loadRun(activeRunId);
  }
  void loadInventory();
  void loadRuns();
});

async function loadRuns() {
  try {
    const response = await fetch("/api/runs");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "Failed to load runs");
    }

    renderRunList(data.runs ?? []);

    if (!activeRunId && data.runs?.[0]) {
      activeRunId = data.runs[0].id;
      renderRun(data.runs[0]);

      if (data.runs[0].status === "running" || data.runs[0].status === "queued") {
        connectRunStream(data.runs[0].id);
      }
    }
  } catch {
    runList.replaceChildren(emptyRunListItem("Runs unavailable"));
  }
}

function renderRunList(runs) {
  const items = runs.slice(0, 8).map((run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `run-list-item status-${run.status}`;
    button.dataset.active = run.id === activeRunId ? "true" : "false";
    button.addEventListener("click", () => {
      activeRunId = run.id;
      void loadRun(run.id);
      connectRunStream(run.id);
    });

    const title = element("span", "run-list-title");
    title.textContent = run.task;
    const meta = element("span", "run-list-meta");
    meta.textContent = `${run.status} · ${formatRunDuration(run)}`;
    button.append(title, meta);

    return button;
  });

  runList.replaceChildren(...(items.length > 0 ? items : [emptyRunListItem("No runs yet")]));
}

function emptyRunListItem(text) {
  const item = document.createElement("div");
  item.className = "run-list-empty";
  item.textContent = text;
  return item;
}

async function loadInventory() {
  try {
    const [toolsResponse, memoriesResponse, buildRequestsResponse] = await Promise.all([
      fetch("/api/tools"),
      fetch("/api/memories"),
      fetch("/api/tool-build-requests"),
    ]);
    const [{ tools }, { memories }, { requests }] = await Promise.all([
      toolsResponse.json(),
      memoriesResponse.json(),
      buildRequestsResponse.json(),
    ]);

    inventorySummary.textContent = `${tools.length} tools · ${memories.length} memories · ${requests.length} build requests`;
    toolList.replaceChildren(
      ...tools.map((tool) =>
        inventoryItem(
          `${tool.name} v${tool.version}`,
          `${tool.description} · ${tool.source ?? "builtin"} · ${tool.status ?? "available"} · ${tool.startupMode} · ${tool.capabilities.join(", ")}`,
        ),
      ),
    );
    memoryList.replaceChildren(
      ...memories
        .slice(0, 8)
        .map((memory) => inventoryItem(memory.title, `${memory.tags.join(", ")} · ${memory.summary}`)),
    );
    toolBuildRequestList.replaceChildren(
      ...(requests.length > 0
        ? requests
            .slice(0, 8)
            .map((request) =>
              inventoryItem(
                `${request.capability} · ${request.status}`,
                buildRequestDetail(request),
              ),
            )
        : [inventoryItem("No pending build requests", "Missing capabilities will appear here.")]),
    );
    await loadModelTiers();
  } catch {
    inventorySummary.textContent = "Inventory unavailable";
  }
}

async function loadModelTiers() {
  const response = await fetch("/api/settings/model-tiers");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Failed to load model tiers");

  renderModelTiers(data.tiers ?? []);
}

function renderModelTiers(tiers) {
  modelTierList.replaceChildren(
    ...tiers.map((tier) => {
      const item = document.createElement("div");
      item.className = "model-tier-item";
      item.dataset.tier = tier.tier;

      const title = element("strong", "model-tier-name");
      title.textContent = `Tier ${tier.tier}`;

      const models = document.createElement("input");
      models.className = "model-tier-models";
      models.value = tier.models.join(", ");
      models.setAttribute("aria-label", `Tier ${tier.tier} models`);

      const attempts = document.createElement("input");
      attempts.className = "model-tier-attempts";
      attempts.type = "number";
      attempts.min = "1";
      attempts.max = "5";
      attempts.value = String(tier.maxAttempts);
      attempts.setAttribute("aria-label", `Tier ${tier.tier} max attempts`);

      const escalateLabel = document.createElement("label");
      escalateLabel.className = "model-tier-escalate";
      const escalate = document.createElement("input");
      escalate.type = "checkbox";
      escalate.checked = tier.escalateOnFailure;
      escalateLabel.append(escalate, document.createTextNode("Escalate"));

      item.append(title, models, attempts, escalateLabel);
      return item;
    }),
  );
}

async function saveModelTiers() {
  saveModelTiersButton.disabled = true;
  const originalText = saveModelTiersButton.textContent;
  saveModelTiersButton.textContent = "Saving...";

  try {
    const tiers = [...modelTierList.querySelectorAll(".model-tier-item")].map((item) => ({
      tier: item.dataset.tier,
      models: item
        .querySelector(".model-tier-models")
        .value.split(",")
        .map((model) => model.trim())
        .filter(Boolean),
      maxAttempts: Number(item.querySelector(".model-tier-attempts").value),
      escalateOnFailure: item.querySelector(".model-tier-escalate input").checked,
    }));

    const response = await fetch("/api/settings/model-tiers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tiers }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Failed to save model tiers");

    renderModelTiers(data.tiers);
    saveModelTiersButton.textContent = "Saved";
    window.setTimeout(() => {
      saveModelTiersButton.textContent = originalText;
    }, 1200);
  } catch (error) {
    saveModelTiersButton.textContent = "Error";
    connectionStatus.textContent = error instanceof Error ? error.message : "Error";
    window.setTimeout(() => {
      saveModelTiersButton.textContent = originalText;
    }, 1800);
  } finally {
    saveModelTiersButton.disabled = false;
  }
}

function inventoryItem(title, detail) {
  const item = document.createElement("li");
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = title;
  span.textContent = detail;
  item.append(strong, span);
  return item;
}

function buildRequestDetail(request) {
  const parts = [
    request.contract?.toolName ?? "tool",
    request.registeredToolName ? `registered: ${request.registeredToolName}` : undefined,
    request.statusDetail,
    request.qaReport ? `QA: ${request.qaReport.ok ? "passed" : "failed"} · ${request.qaReport.summary}` : undefined,
    request.reason,
  ].filter(Boolean);

  return parts.join(" · ");
}

function startPolling() {
  stopPolling();
  connectionStatus.textContent = "Polling";
  pollTimer = window.setInterval(() => {
    if (activeRunId) {
      void loadRun(activeRunId);
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function connectRunStream(id) {
  closeRunStream();
  stopPolling();

  if (!window.EventSource) {
    startPolling();
    return;
  }

  runStream = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  connectionStatus.textContent = "Connecting";

  runStream.addEventListener("open", () => {
    connectionStatus.textContent = "Live";
  });

  runStream.addEventListener("run", (event) => {
    const data = JSON.parse(event.data);
    renderRun(data.run);
  });

  runStream.addEventListener("error", () => {
    if (currentRun?.status === "completed" || currentRun?.status === "failed") {
      closeRunStream();
      connectionStatus.textContent = "Ready";
      return;
    }

    closeRunStream();
    startPolling();
  });
}

function closeRunStream() {
  if (runStream) {
    runStream.close();
    runStream = null;
  }
}

function startLiveClock() {
  if (liveClockTimer !== null) return;

  liveClockTimer = window.setInterval(updateLiveDurations, 250);
}

function stopLiveClock() {
  if (liveClockTimer !== null) {
    window.clearInterval(liveClockTimer);
    liveClockTimer = null;
  }
}

window.addEventListener("resize", () => {
  scheduleArrowRender();
});

async function loadRun(id) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "Failed to load run");
    }

    renderRun(data.run);
  } catch (error) {
    connectionStatus.textContent = "Disconnected";
    answerOutput.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderRun(run) {
  currentRun = run;
  activeRunLabel.textContent = run.id;
  runStatus.textContent = run.status;
  runStatus.className = `status-${run.status}`;
  updateLiveDurations();
  connectionStatus.textContent =
    run.status === "running" || run.status === "queued"
      ? runStream
        ? "Live"
        : "Running"
      : "Ready";

  renderEvents(run.events ?? []);

  if (run.status === "completed") {
    answerOutput.textContent = run.result?.finalAnswer ?? "Completed without final answer.";
    renderArtifacts(run.result?.artifacts ?? []);
    setBusy(false);
    stopPolling();
    closeRunStream();
    stopLiveClock();
    void loadRuns();
  } else if (run.status === "failed") {
    answerOutput.textContent = run.error ?? "Run failed.";
    renderArtifacts([]);
    setBusy(false);
    stopPolling();
    closeRunStream();
    stopLiveClock();
    void loadRuns();
  } else {
    answerOutput.textContent = latestMeaningfulEvent(run.events) ?? "Agent is working...";
    renderArtifacts(run.result?.artifacts ?? []);
    setBusy(true);
    startLiveClock();
  }
}

async function readSelectedFiles() {
  const files = [...(fileInput.files ?? [])];
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      contentBase64: await fileToBase64(file),
      description: "User attached input file",
    })),
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() : value);
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file")));
    reader.readAsDataURL(file);
  });
}

function renderSelectedFiles() {
  const files = [...(fileInput.files ?? [])];
  attachmentList.replaceChildren(
    ...(files.length > 0
      ? files.map((file) => attachmentChip(file))
      : [pill("No files attached", "muted")]),
  );
}

function renderArtifacts(artifacts) {
  artifactPanel.hidden = artifacts.length === 0;
  artifactSummary.textContent = `${artifacts.length} file${artifacts.length === 1 ? "" : "s"}`;
  artifactList.replaceChildren(...artifacts.map(renderArtifactCard));
  scheduleArrowRender();
}

function attachmentChip(file) {
  const item = document.createElement("span");
  item.className = "attachment-chip";
  const name = document.createElement("strong");
  name.textContent = file.name;
  const meta = document.createElement("span");
  meta.textContent = `${file.type || "file"} · ${formatBytes(file.size)}`;
  item.append(name, meta);
  return item;
}

function renderArtifactCard(artifact) {
  const card = document.createElement("article");
  card.className = `artifact-card artifact-${artifact.kind}`;

  if (isPreviewableImage(artifact)) {
    const previewLink = document.createElement("a");
    previewLink.href = artifact.url;
    previewLink.target = "_blank";
    previewLink.rel = "noreferrer";
    previewLink.className = "artifact-preview";

    const image = document.createElement("img");
    image.src = artifact.url;
    image.alt = artifact.filename;
    image.loading = "lazy";
    previewLink.append(image);
    card.append(previewLink);
  }

  const body = document.createElement("div");
  body.className = "artifact-body";
  const title = document.createElement("a");
  title.className = "artifact-title";
  title.href = artifact.url;
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = artifact.filename;

  const meta = document.createElement("div");
  meta.className = "artifact-meta";
  meta.textContent = `${artifact.kind} · ${artifact.mimeType} · ${formatBytes(artifact.sizeBytes)}`;

  const url = document.createElement("code");
  url.className = "artifact-url";
  url.textContent = artifact.url;

  body.append(title, meta, url);
  card.append(body);
  return card;
}

function isPreviewableImage(artifact) {
  return artifact.mimeType?.startsWith("image/");
}

function renderEvents(events) {
  const nodes = buildTraceNodes(events);
  currentTraceNodes = nodes;
  const signature = nodes.map(nodeSignature).join("|");
  if (eventList.dataset.signature === signature) {
    return;
  }

  eventList.dataset.signature = signature;
  syncTraceBoard(nodes);
}

function syncTraceBoard(nodes) {
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  const cardsBySpan = new Map(
    [...eventList.querySelectorAll(".trace-card")].map((card) => [card.dataset.spanId, card]),
  );

  for (const column of [...eventList.querySelectorAll(".trace-column")]) {
    const depth = Number(column.dataset.depth);
    if (depth > maxDepth) {
      column.remove();
    }
  }

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const column = getOrCreateColumn(depth);
    const nodesForDepth = nodes.filter((item) => item.depth === depth);

    for (const node of nodesForDepth) {
      const existingCard = cardsBySpan.get(node.spanId);
      const card = existingCard ?? renderTraceNode(node);
      updateTraceNode(card, node);
      column.append(card);
    }

    for (const card of [...column.querySelectorAll(".trace-card")]) {
      if (!nodesForDepth.some((node) => node.spanId === card.dataset.spanId)) {
        card.remove();
      }
    }
  }

  scheduleArrowRender();
}

function getOrCreateColumn(depth) {
  const existing = eventList.querySelector(`.trace-column[data-depth="${depth}"]`);
  if (existing) return existing;

  const column = document.createElement("section");
  column.className = "trace-column";
  column.dataset.depth = String(depth);

  const label = document.createElement("div");
  label.className = "trace-column-label";
  label.textContent = columnLabel(depth);
  column.append(label);
  eventList.append(column);

  return column;
}

function renderTraceNode(node) {
  const item = document.createElement("section");
  item.dataset.spanId = node.spanId;
  item.className = `trace-card status-${node.status} is-new`;
  item.tabIndex = 0;
  item.append(
    element("div", "event-title"),
    element("div", "event-meta"),
    element("div", "event-detail-preview"),
    element("button", "trace-toggle"),
    element("div", "event-detail"),
  );
  item.addEventListener("click", (event) => {
    if (event.target.closest(".trace-toggle")) return;
    toggleTraceCard(item);
  });
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleTraceCard(item);
    }
  });
  updateTraceNode(item, node);
  window.setTimeout(() => item.classList.remove("is-new"), 260);

  return item;
}

function updateTraceNode(item, node) {
  item.dataset.spanId = node.spanId;
  const wasNew = item.classList.contains("is-new");
  item.className = `trace-card status-${node.status}${wasNew ? " is-new" : ""}`;

  const title = item.querySelector(".event-title");
  const meta = item.querySelector(".event-meta");
  const preview = item.querySelector(".event-detail-preview");
  const toggle = item.querySelector(".trace-toggle");
  const detail = item.querySelector(".event-detail");

  const titleText = document.createElement("span");
  titleText.textContent = node.title;

  const badges = document.createElement("div");
  badges.className = "event-badges";
  const modelTier = modelTierFor(node);
  badges.append(
    badge(node.actor),
    badge(node.activity),
    badge(node.status, `status-${node.status}`),
    badge(formatNodeDuration(node), "event-duration"),
  );
  if (modelTier) {
    badges.append(badge(`Tier ${modelTier}`, "tier-badge"));
  }
  if (node.dependencySpanIds?.length > 0) {
    badges.append(badge(`waits ${node.dependencySpanIds.length}`, "dependency-badge"));
  }

  title.replaceChildren(titleText, badges);
  meta.textContent = `${node.startedAt ? new Date(node.startedAt).toLocaleTimeString() : ""}${
    node.parentTitle ? ` -> ${node.parentTitle}` : ""
  }`;
  preview.textContent = node.detail ? truncate(node.detail, 170) : "";
  preview.hidden = !node.detail;
  toggle.textContent = item.dataset.expanded === "true" ? "Collapse" : "Details";
  toggle.hidden = !node.detail || node.detail.length <= 170;
  toggle.type = "button";
  toggle.onclick = (event) => {
    event.stopPropagation();
    toggleTraceCard(item);
  };
  detail.textContent = node.detail ?? "";
  detail.hidden = item.dataset.expanded !== "true" || !node.detail;
  item.dataset.startedAt = node.startedAt ?? "";
  item.dataset.completedAt = node.completedAt ?? "";
  item.dataset.durationMs = typeof node.durationMs === "number" ? String(node.durationMs) : "";
  item.dataset.status = node.status;
}

function columnLabel(depth) {
  if (depth === 0) return "Coordinator";
  if (depth === 1) return "Coordinator steps";
  if (depth === 2) return "Specialists";
  if (depth === 3) return "Tools & reviews";
  return `Layer ${depth + 1}`;
}

function toggleTraceCard(card) {
  card.dataset.expanded = card.dataset.expanded === "true" ? "false" : "true";
  const detail = card.querySelector(".event-detail");
  const toggle = card.querySelector(".trace-toggle");
  const isExpanded = card.dataset.expanded === "true";

  detail.hidden = !isExpanded;
  toggle.textContent = isExpanded ? "Collapse" : "Details";
  scheduleArrowRender();
}

function buildTraceNodes(events) {
  const bySpan = new Map();

  for (const event of events) {
    const existing = bySpan.get(event.spanId) ?? {
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      title: event.title,
      actor: event.actor,
      activity: event.activity,
      status: event.status,
      detail: event.detail,
      startedAt: event.startedAt ?? event.timestamp,
      completedAt: event.completedAt,
      durationMs: event.durationMs,
      payload: event.payload,
      firstTimestamp: event.timestamp,
      lastTimestamp: event.timestamp,
    };

    bySpan.set(event.spanId, {
      ...existing,
      parentSpanId: existing.parentSpanId ?? event.parentSpanId,
      title: event.title ?? existing.title,
      actor: event.actor ?? existing.actor,
      activity: event.activity ?? existing.activity,
      status: event.status ?? existing.status,
      detail: event.detail ?? existing.detail,
      startedAt: existing.startedAt ?? event.startedAt ?? event.timestamp,
      completedAt: event.completedAt ?? existing.completedAt,
      durationMs: event.durationMs ?? existing.durationMs,
      payload: event.payload ?? existing.payload,
      lastTimestamp: event.timestamp,
    });
  }

  const nodes = [...bySpan.values()].sort((a, b) =>
    a.firstTimestamp.localeCompare(b.firstTimestamp),
  );
  const titleBySpan = new Map(nodes.map((node) => [node.spanId, node.title]));

  return nodes.map((node) => ({
    ...node,
    depth: depthFor(node, bySpan),
    parentTitle: node.parentSpanId ? titleBySpan.get(node.parentSpanId) : undefined,
    dependencySpanIds: dependencySpanIdsFor(node),
  }));
}

function depthFor(node, bySpan) {
  let depth = 0;
  let current = node;

  while (current.parentSpanId && bySpan.has(current.parentSpanId)) {
    depth += 1;
    current = bySpan.get(current.parentSpanId);
  }

  return Math.min(depth, 6);
}

function latestMeaningfulEvent(events = []) {
  const latest = [...events].reverse().find((event) => event.detail || event.title);
  return latest ? `${latest.title}${latest.detail ? `\n\n${latest.detail}` : ""}` : undefined;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  taskInput.disabled = isBusy;
  fileInput.disabled = isBusy;
}

function badge(text, className = "") {
  const element = document.createElement("span");
  element.className = `event-badge ${className}`;
  element.textContent = text ?? "-";
  return element;
}

function pill(text, className = "") {
  const item = document.createElement("span");
  item.className = `inline-pill ${className}`;
  item.textContent = text;
  return item;
}

function element(tagName, className) {
  const item = document.createElement(tagName);
  item.className = className;
  return item;
}

function nodeSignature(node) {
  return [
    node.spanId,
    node.parentSpanId ?? "",
    (node.dependencySpanIds ?? []).join(","),
    node.depth,
    node.title,
    node.actor,
    node.activity,
    node.status,
    node.durationMs ?? "",
    modelTierFor(node) ?? "",
    node.detail ?? "",
  ].join("::");
}

function modelTierFor(node) {
  if (!node?.payload || typeof node.payload !== "object") return undefined;
  const tier = node.payload.modelTier;
  return typeof tier === "string" ? tier : undefined;
}

function dependencySpanIdsFor(node) {
  if (!node?.payload || typeof node.payload !== "object") return [];
  const spanIds = node.payload.dependencySpanIds;
  return Array.isArray(spanIds) ? spanIds.filter((spanId) => typeof spanId === "string") : [];
}

function formatDuration(durationMs, status = "completed") {
  if (typeof durationMs !== "number") return status === "started" ? "running" : "-";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatRunDuration(run) {
  const started = new Date(run.createdAt).getTime();
  const ended =
    run.status === "running" || run.status === "queued"
      ? Date.now()
      : new Date(run.updatedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "0 ms";
  return formatDuration(Math.max(0, ended - started));
}

function formatNodeDuration(node) {
  if (typeof node.durationMs === "number") return formatDuration(node.durationMs);
  if (!node.startedAt || node.status !== "started") return formatDuration(undefined, node.status);

  const started = new Date(node.startedAt).getTime();
  if (!Number.isFinite(started)) return "running";
  return formatDuration(Math.max(0, Date.now() - started));
}

function updateLiveDurations() {
  if (currentRun) {
    runDuration.textContent = formatRunDuration(currentRun);
  }

  for (const card of eventList.querySelectorAll(".trace-card")) {
    const duration = card.querySelector(".event-duration");
    if (!duration) continue;

    const explicitDuration = Number(card.dataset.durationMs);
    if (Number.isFinite(explicitDuration) && card.dataset.durationMs !== "") {
      duration.textContent = formatDuration(explicitDuration);
      continue;
    }

    if (card.dataset.status !== "started" || !card.dataset.startedAt) continue;
    const started = new Date(card.dataset.startedAt).getTime();
    if (Number.isFinite(started)) {
      duration.textContent = formatDuration(Math.max(0, Date.now() - started));
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function scheduleArrowRender() {
  if (traceLayoutTimer) {
    window.cancelAnimationFrame(traceLayoutTimer);
  }

  traceLayoutTimer = window.requestAnimationFrame(renderTraceArrows);
}

function renderTraceArrows() {
  let svg = eventList.querySelector(".trace-arrows");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("trace-arrows");
    eventList.prepend(svg);
  }

  const cards = [...eventList.querySelectorAll(".trace-card")];
  const boardRect = eventList.getBoundingClientRect();
  const width = Math.max(eventList.scrollWidth, eventList.clientWidth);
  const height = Math.max(eventList.scrollHeight, eventList.clientHeight);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const marker = `
    <defs>
      <marker id="arrow-head" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M0,0 L8,4.5 L0,9 Z" fill="#7ce5ff"></path>
      </marker>
    </defs>
  `;
  const paths = [];

  for (const card of cards) {
    for (const parentSpanId of findParentSpanIds(card.dataset.spanId)) {
      const parent = eventList.querySelector(`.trace-card[data-span-id="${cssEscape(parentSpanId)}"]`);
      if (!parent) continue;

      const from = pointFor(parent, boardRect, "right");
      const to = pointFor(card, boardRect, "left");
      const midX = Math.max(from.x + 24, (from.x + to.x) / 2);
      paths.push(
        `<path d="M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 8} ${to.y}" />`,
      );
    }
  }

  svg.innerHTML = `${marker}<g>${paths.join("")}</g>`;
}

function findParentSpanIds(spanId) {
  const node = currentTraceNodes.find((item) => item.spanId === spanId);
  if (!node) return [];

  return [...new Set([node.parentSpanId, ...(node.dependencySpanIds ?? [])].filter(Boolean))];
}

function pointFor(element, boardRect, side) {
  const rect = element.getBoundingClientRect();
  const x = side === "right" ? rect.right - boardRect.left + eventList.scrollLeft : rect.left - boardRect.left + eventList.scrollLeft;
  const y = rect.top + rect.height / 2 - boardRect.top + eventList.scrollTop;

  return { x, y };
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
