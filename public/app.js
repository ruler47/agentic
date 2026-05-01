const form = document.querySelector("#taskForm");
const taskInput = document.querySelector("#taskInput");
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
const runList = document.querySelector("#runList");
const modelTierList = document.querySelector("#modelTierList");
const saveModelTiersButton = document.querySelector("#saveModelTiersButton");

let activeRunId = null;
let pollTimer = null;
let traceLayoutTimer = null;
let currentTraceNodes = [];

void loadInventory();
void loadRuns();

saveModelTiersButton.addEventListener("click", () => {
  void saveModelTiers();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task) return;

  setBusy(true);
  answerOutput.textContent = "Starting agent run...";
  eventList.replaceChildren();
  eventList.dataset.signature = "";

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "Failed to start run");
    }

    activeRunId = data.run.id;
    renderRun(data.run);
    void loadRuns();
    startPolling();
  } catch (error) {
    setBusy(false);
    connectionStatus.textContent = "Error";
    answerOutput.textContent = error instanceof Error ? error.message : String(error);
  }
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
        startPolling();
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
    const [toolsResponse, memoriesResponse] = await Promise.all([
      fetch("/api/tools"),
      fetch("/api/memories"),
    ]);
    const [{ tools }, { memories }] = await Promise.all([
      toolsResponse.json(),
      memoriesResponse.json(),
    ]);

    inventorySummary.textContent = `${tools.length} tools · ${memories.length} memories`;
    toolList.replaceChildren(
      ...tools.map((tool) =>
        inventoryItem(
          `${tool.name} v${tool.version}`,
          `${tool.description} · ${tool.startupMode} · ${tool.capabilities.join(", ")}`,
        ),
      ),
    );
    memoryList.replaceChildren(
      ...memories
        .slice(0, 8)
        .map((memory) => inventoryItem(memory.title, `${memory.tags.join(", ")} · ${memory.summary}`)),
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

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (activeRunId) {
      void loadRun(activeRunId);
    }
  }, 1000);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
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
  activeRunLabel.textContent = run.id;
  runStatus.textContent = run.status;
  runStatus.className = `status-${run.status}`;
  runDuration.textContent = formatRunDuration(run);
  connectionStatus.textContent = run.status === "running" ? "Running" : "Ready";

  renderEvents(run.events ?? []);

  if (run.status === "completed") {
    answerOutput.textContent = run.result?.finalAnswer ?? "Completed without final answer.";
    setBusy(false);
    stopPolling();
    void loadRuns();
  } else if (run.status === "failed") {
    answerOutput.textContent = run.error ?? "Run failed.";
    setBusy(false);
    stopPolling();
    void loadRuns();
  } else {
    answerOutput.textContent = latestMeaningfulEvent(run.events) ?? "Agent is working...";
    setBusy(true);
  }
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
  item.className = `trace-card status-${node.status}`;
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

  return item;
}

function updateTraceNode(item, node) {
  item.dataset.spanId = node.spanId;
  item.className = `trace-card status-${node.status}`;

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
    badge(formatDuration(node.durationMs, node.status)),
  );
  if (modelTier) {
    badges.append(badge(`Tier ${modelTier}`, "tier-badge"));
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
}

function badge(text, className = "") {
  const element = document.createElement("span");
  element.className = `event-badge ${className}`;
  element.textContent = text ?? "-";
  return element;
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

function formatDuration(durationMs, status = "completed") {
  if (typeof durationMs !== "number") return status === "started" ? "running" : "-";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatRunDuration(run) {
  const started = new Date(run.createdAt).getTime();
  const ended = new Date(run.updatedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "0 ms";
  return formatDuration(Math.max(0, ended - started));
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
    const parentSpanId = findParentSpanId(card.dataset.spanId);
    if (!parentSpanId) continue;

    const parent = eventList.querySelector(`.trace-card[data-span-id="${cssEscape(parentSpanId)}"]`);
    if (!parent) continue;

    const from = pointFor(parent, boardRect, "right");
    const to = pointFor(card, boardRect, "left");
    const midX = Math.max(from.x + 24, (from.x + to.x) / 2);
    paths.push(
      `<path d="M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 8} ${to.y}" />`,
    );
  }

  svg.innerHTML = `${marker}<g>${paths.join("")}</g>`;
}

function findParentSpanId(spanId) {
  const node = currentTraceNodes.find((item) => item.spanId === spanId);
  return node?.parentSpanId;
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
