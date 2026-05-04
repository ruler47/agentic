const app = document.querySelector("#app");

const routes = [
  {
    group: "Work",
    items: [
      { id: "dashboard", label: "Dashboard", description: "Start work and monitor active agent runs." },
      { id: "runs", label: "Runs", description: "Search and reopen past executions." },
      { id: "conversations", label: "Conversations", description: "Continue threads and inspect context." },
    ],
  },
  {
    group: "Analysis",
    items: [
      { id: "trace", label: "Trace Lab", description: "Debug agent timelines, graphs, and logs." },
      { id: "memory", label: "Memory", description: "Review scoped knowledge and proposed facts." },
      { id: "artifacts", label: "Artifacts", description: "Browse generated files and proof." },
    ],
  },
  {
    group: "Build",
    items: [
      { id: "tools", label: "Tools", description: "Registry, schemas, health, and credentials." },
      { id: "tool-builds", label: "Tool Builds", description: "Build API, browser, file, bot, webhook, and service tools." },
      { id: "models", label: "Models", description: "Providers, tiers, fallbacks, and health." },
    ],
  },
  {
    group: "Control",
    items: [
      { id: "group-profile", label: "Group Profile", description: "Shared context, preferences, rules, and goals." },
      { id: "users", label: "Users", description: "Members, identities, roles, and access." },
      { id: "channels", label: "Channels", description: "Runtime view for always-on intake tools and message routing." },
      { id: "policies", label: "Policies", description: "Memory, tools, outbound, and federation rules." },
      { id: "approvals", label: "Approvals", description: "Human decisions before sensitive actions." },
      { id: "scheduler", label: "Scheduler", description: "Reminders, recurring jobs, and alerts." },
    ],
  },
  {
    group: "System",
    items: [
      { id: "audit-log", label: "Audit Log", description: "Every significant action, decision, and change." },
      { id: "settings", label: "Settings", description: "Instance, locale, storage, secrets, and backups." },
      { id: "diagnostics", label: "Diagnostics", description: "Runtime health and operational tools." },
    ],
  },
];

const state = {
  route: parseRoute(),
  instance: undefined,
  groupProfile: undefined,
  runs: [],
  conversations: [],
  memories: [],
  memoryReviews: [],
  tools: [],
  toolServices: [],
  toolServiceLogs: [],
  toolServiceEvents: [],
  toolMigrations: [],
  buildRequests: [],
  secretHandles: [],
  tiers: [],
  modelProviders: [],
  modelCatalog: undefined,
  users: [],
  auditEvents: [],
  activeRunId: undefined,
  activeThreadId: undefined,
  dashboardThreadId: undefined,
  traceMode: "timeline",
  selectedMemoryId: undefined,
  memoryFilter: "all",
  selectedToolName: undefined,
  toolSearch: "",
  hoveredGraphSpanId: undefined,
  traceGraphLayout: "category",
  traceFilters: {
    actor: "all",
    activity: "all",
    status: "all",
    tool: "all",
    modelTier: "all",
  },
  selectedSpanId: undefined,
  loading: true,
  error: undefined,
  notice: undefined,
  stream: undefined,
  serviceLogStream: undefined,
};

window.addEventListener("hashchange", () => {
  state.route = parseRoute();
  syncActiveFromRoute();
  connectRunStream(activeRun()?.id);
  connectServiceLogStream();
  render();
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.action === "run-agent") {
    void submitRun(form);
  }
  if (form.dataset.action === "save-model-tiers") {
    void saveModelTiers(form);
  }
  if (form.dataset.action === "create-model-provider") {
    void createModelProvider(form);
  }
  if (form.dataset.action === "save-group-profile") {
    void saveGroupProfile(form);
  }
  if (form.dataset.action === "save-memory") {
    void saveMemory(form);
  }
  if (form.dataset.action === "create-tool-build-request") {
    void createToolBuildRequest(form);
  }
  if (form.dataset.action === "rework-tool-build") {
    void reworkToolBuild(form);
  }
  if (form.dataset.action === "rework-tool") {
    void reworkTool(form);
  }
  if (form.dataset.action === "activate-tool-version") {
    void activateToolVersion(form);
  }
  if (form.dataset.action === "create-secret-handle") {
    void createSecretHandle(form);
  }
  if (form.dataset.action === "create-user") {
    void createUser(form);
  }
  if (form.dataset.action === "update-user") {
    void updateUser(form);
  }
  if (form.dataset.action === "create-channel-identity") {
    void createChannelIdentity(form);
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.action === "search-tools") {
    state.toolSearch = target.value;
    const selectionStart = target.selectionStart;
    const selectionEnd = target.selectionEnd;
    render();
    const nextInput = document.querySelector('input[data-action="search-tools"]');
    if (nextInput instanceof HTMLInputElement) {
      nextInput.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action || action.tagName === "FORM") return;

  const {
    action: actionName,
    route,
    runId,
    threadId,
    spanId,
    traceMode,
    traceGraphLayout,
    memoryId,
    memoryStatus,
    toolName,
    buildId,
    secretHandle,
    memoryFilter,
    userId,
    identityId,
    allowStatus,
    providerId,
    serviceToolName,
    serviceAction,
  } = action.dataset;
  if (actionName === "navigate" && route) {
    navigate(route);
  }
  if (actionName === "refresh") {
    void refreshData();
  }
  if (actionName === "dismiss-notice") {
    state.notice = undefined;
    render();
  }
  if (actionName === "select-run" && runId) {
    navigate(`run/${runId}`);
  }
  if (actionName === "cancel-run" && runId) {
    void cancelRun(runId);
  }
  if (actionName === "open-trace" && runId) {
    navigate(`trace/${runId}`);
  }
  if (actionName === "select-thread" && threadId) {
    navigate(`conversation/${threadId}`);
  }
  if (actionName === "continue-thread" && threadId) {
    state.activeThreadId = threadId;
    navigate(`conversation/${threadId}`);
  }
  if (actionName === "delete-thread" && threadId) {
    void deleteConversationThread(threadId);
  }
  if (actionName === "set-trace-mode" && traceMode) {
    state.traceMode = traceMode;
    render();
  }
  if (actionName === "set-trace-graph-layout" && traceGraphLayout) {
    state.traceGraphLayout = traceGraphLayout;
    state.selectedSpanId = undefined;
    render();
  }
  if (actionName === "select-span" && spanId) {
    state.selectedSpanId = spanId;
    render();
  }
  if (actionName === "select-memory" && memoryId) {
    state.selectedMemoryId = memoryId;
    render();
  }
  if (actionName === "set-memory-filter" && memoryFilter) {
    state.memoryFilter = memoryFilter;
    state.selectedMemoryId = undefined;
    render();
  }
  if (actionName === "update-memory-status" && memoryId && memoryStatus) {
    void updateMemoryStatus(memoryId, memoryStatus);
  }
  if (actionName === "rebuild-memory-embeddings") {
    void rebuildMemoryEmbeddings();
  }
  if (actionName === "select-tool" && toolName) {
    state.selectedToolName = toolName;
    render();
  }
  if (actionName === "delete-tool" && toolName) {
    void deleteTool(toolName);
  }
  if (actionName === "run-tool-health") {
    void runToolHealthchecks();
  }
  if (actionName === "tool-service-action" && serviceToolName && serviceAction) {
    void updateToolService(serviceToolName, serviceAction);
  }
  if (actionName === "run-tool-build" && buildId) {
    void runToolBuild(buildId);
  }
  if (actionName === "stop-tool-build" && buildId) {
    void stopToolBuild(buildId);
  }
  if (actionName === "delete-tool-build" && buildId) {
    void deleteToolBuild(buildId);
  }
  if (actionName === "delete-secret-handle" && secretHandle) {
    void deleteSecretHandle(secretHandle);
  }
  if (actionName === "delete-model-provider" && providerId) {
    void deleteModelProvider(providerId);
  }
  if (actionName === "delete-user" && userId) {
    void deleteUser(userId);
  }
  if (actionName === "toggle-channel-identity" && identityId && allowStatus) {
    void updateChannelIdentity(identityId, { allowStatus });
  }
  if (actionName === "delete-channel-identity" && identityId) {
    void deleteChannelIdentity(identityId);
  }
});

document.addEventListener("pointerover", (event) => {
  const node = event.target.closest?.(".graph-node");
  if (!(node instanceof HTMLElement)) return;
  state.hoveredGraphSpanId = node.dataset.spanId;
  highlightGraphRelations(state.hoveredGraphSpanId);
});

document.addEventListener("pointerout", (event) => {
  const node = event.target.closest?.(".graph-node");
  if (!(node instanceof HTMLElement)) return;
  if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
  state.hoveredGraphSpanId = undefined;
  highlightGraphRelations(undefined);
});

window.addEventListener("resize", () => {
  drawGraphEdges();
  highlightGraphRelations(state.hoveredGraphSpanId ?? state.selectedSpanId);
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.name === "threadMode") updateComposerMode(target.closest("form"));
  if (target.name === "threadId") state.dashboardThreadId = target.value || undefined;
  if (target.dataset.action === "select-trace-run" && target instanceof HTMLSelectElement) {
    navigate(`trace/${target.value}`);
  }
  if (target.dataset.action === "set-trace-filter" && target instanceof HTMLSelectElement) {
    const key = target.dataset.filterKey;
    if (key && key in state.traceFilters) {
      state.traceFilters[key] = target.value;
      state.selectedSpanId = undefined;
      render();
    }
  }
});

void refreshData();
window.setInterval(updateLiveTimers, 500);

async function refreshData() {
  state.loading = true;
  state.error = undefined;
  render();

  try {
    const [
      instance,
      groupProfile,
      runs,
      conversations,
      memories,
      memoryReviews,
      tools,
      toolMigrations,
      buildRequests,
      secretHandles,
      toolServices,
      toolServiceLogs,
      toolServiceEvents,
      tiers,
      modelProviders,
      modelCatalog,
      users,
      auditEvents,
    ] = await Promise.all([
      fetchJson("/api/instance").then((data) => data.instance),
      fetchJson("/api/group-profile").then((data) => data.groupProfile),
      fetchJson("/api/runs").then((data) => data.runs ?? []),
      fetchJson("/api/conversation-threads").then((data) => data.threads ?? []),
      fetchJson("/api/memories").then((data) => data.memories ?? []),
      fetchJson("/api/memories/review-queue").then((data) => data.reviews ?? []),
      fetchJson("/api/tools").then((data) => data.tools ?? []),
      fetchJson("/api/tool-migrations").then((data) => data.migrations ?? []),
      fetchJson("/api/tool-build-requests").then((data) => data.requests ?? []),
      fetchJson("/api/secret-handles").then((data) => data.secretHandles ?? []),
      fetchJson("/api/tool-services").then((data) => data.services ?? []),
      fetchJson("/api/tool-services/logs?limit=80").then((data) => data.logs ?? []),
      fetchJson("/api/tool-service-events?limit=80").then((data) => data.events ?? []),
      fetchJson("/api/settings/model-tiers").then((data) => data.tiers ?? []),
      fetchJson("/api/model-providers").then((data) => data.providers ?? []),
      fetchJson("/api/models/catalog").catch(() => undefined),
      fetchJson("/api/users").then((data) => data.users ?? []),
      fetchJson("/api/audit-events").then((data) => data.events ?? []),
    ]);

    Object.assign(state, {
      instance,
      groupProfile,
      runs,
      conversations,
      memories,
      memoryReviews,
      tools,
      toolMigrations,
      buildRequests,
      secretHandles,
      toolServices,
      toolServiceLogs,
      toolServiceEvents,
      tiers,
      modelProviders,
      modelCatalog,
      users,
      auditEvents,
      activeRunId: state.activeRunId ?? runs[0]?.id,
      loading: false,
    });
    syncActiveFromRoute();
    connectRunStream(activeRun()?.id);
    connectServiceLogStream();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
  }

  render();
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return { page: "dashboard" };
  const [page, id] = hash.split("/");
  return { page: page || "dashboard", id };
}

function navigate(route) {
  const normalized = route.startsWith("/") ? route : `/${route}`;
  window.location.hash = normalized;
}

function syncActiveFromRoute() {
  if (state.route.page === "run" && state.route.id) {
    if (state.activeRunId !== state.route.id) state.selectedSpanId = undefined;
    state.activeRunId = state.route.id;
    const run = activeRun();
    if (run?.threadId) state.activeThreadId = run.threadId;
  }
  if (state.route.page === "trace" && state.route.id) {
    if (state.activeRunId !== state.route.id) state.selectedSpanId = undefined;
    state.activeRunId = state.route.id;
  }
  if (state.route.page === "conversation" && state.route.id) {
    state.activeThreadId = state.route.id;
  }
}

function render() {
  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <div class="page-shell">
        ${renderTopHeader()}
        <main class="page-main page-transition">
          ${renderNotice()}
          ${renderPage()}
        </main>
      </div>
    </div>
  `;
  hydrateAfterRender();
}

function renderSidebar() {
  const health = state.error ? "Degraded" : "Ready";
  return `
    <aside class="sidebar">
      <header class="instance-card">
        <div class="instance-logo">A</div>
        <div class="instance-copy">
          <strong>Agentic</strong>
          <span>${escapeHtml(state.groupProfile?.name ?? "Local Group Profile")}</span>
        </div>
        <span class="status-dot ${state.error ? "failed" : "ready"}"></span>
      </header>
      <nav class="side-nav">
        ${routes
          .map(
            (group) => `
              <section class="nav-group">
                <h2>${group.group}</h2>
                ${group.items
                  .map(
                    (item) => `
                      <button
                        type="button"
                        class="nav-link ${isActiveNav(item.id) ? "active" : ""}"
                        data-action="navigate"
                        data-route="${item.id}"
                      >
                        <span>${item.label}</span>
                      </button>
                    `,
                  )
                  .join("")}
              </section>
            `,
          )
          .join("")}
      </nav>
      <footer class="sidebar-footer">
        <button type="button" class="health-pill ${state.error ? "failed" : "ready"}" data-action="navigate" data-route="diagnostics">
          <span>${health}</span>
          <small>${state.error ? "Needs attention" : "All systems ready"}</small>
        </button>
        <div class="user-pill">
          <span>Admin</span>
          <small>user-admin</small>
        </div>
      </footer>
    </aside>
  `;
}

function renderTopHeader() {
  const meta = routeMeta();
  return `
    <header class="top-header">
      <div>
        <h1>${meta.label}</h1>
        <p>${meta.description}</p>
      </div>
      <div class="top-actions">
        <button type="button" class="command-button" data-action="navigate" data-route="search">
          Search or jump...
          <kbd>⌘K</kbd>
        </button>
        <span class="env-badge">${escapeHtml(state.instance?.id ?? "instance-local")} · ${escapeHtml(state.instance?.timeZone ?? "Europe/Madrid")}</span>
        <button type="button" class="ghost-button" data-action="refresh">Refresh</button>
        <button type="button" class="approval-badge" data-action="navigate" data-route="approvals">
          ${pendingApprovalCount()} approvals
        </button>
      </div>
    </header>
  `;
}

function renderPage() {
  if (state.loading) return renderDashboardSkeleton();
  if (state.error) return renderErrorState(state.error);

  switch (state.route.page) {
    case "dashboard":
      return renderDashboard();
    case "runs":
      return renderRunsList();
    case "run":
      return renderRunWorkspace(activeRun());
    case "trace":
      return state.route.id ? renderTraceLab(activeRun()) : renderTraceRunDirectory();
    case "conversations":
      return renderConversationsList();
    case "conversation":
      return renderConversationDetail(activeThread());
    case "memory":
      return renderMemoryPage();
    case "artifacts":
      return renderArtifactsPage();
    case "tools":
      return renderToolsPage();
    case "tool-builds":
      return renderToolBuildsPage();
    case "models":
      return renderModelsPage();
    case "group-profile":
      return renderGroupProfilePage();
    case "users":
      return renderUsersPage();
    case "channels":
      return renderChannelsPage();
    case "policies":
      return renderPoliciesPage();
    case "approvals":
      return renderApprovalsPage();
    case "scheduler":
      return renderSchedulerPage();
    case "audit-log":
      return renderAuditLogPage();
    case "settings":
      return renderSettingsPage();
    case "diagnostics":
      return renderDiagnosticsPage();
    case "search":
      return renderCommandPalettePage();
    default:
      return renderDashboard();
  }
}

function renderNotice() {
  if (!state.notice) return "";
  return `
    <aside class="notice-banner">
      <div>
        <strong>${escapeHtml(state.notice.title)}</strong>
        <p>${escapeHtml(state.notice.body)}</p>
      </div>
      ${state.notice.route ? `<button type="button" class="primary-button" data-action="navigate" data-route="${escapeHtml(state.notice.route)}">${escapeHtml(state.notice.actionLabel ?? "Open")}</button>` : ""}
      <button type="button" class="ghost-button" data-action="dismiss-notice">Dismiss</button>
    </aside>
  `;
}

function renderDashboard() {
  const activeRuns = state.runs.filter((run) => run.status === "running" || run.status === "queued");
  const recentRuns = state.runs.slice(0, 5);
  return `
    <section class="dashboard-layout">
      <div class="dashboard-primary">
        ${renderComposer({ compact: false, mode: "new" })}
        ${renderActiveRuns(activeRuns)}
        ${renderRecentActivity(recentRuns)}
      </div>
      <aside class="dashboard-secondary">
        ${renderContextPreview()}
        ${renderOperationalInsights()}
        ${renderSystemHealth()}
      </aside>
    </section>
  `;
}

function renderComposer({ compact, mode = "new", selectedThread }) {
  const continuing = mode === "continue" && Boolean(selectedThread);
  const requester = selectedThread?.requesterUserId ?? "user-admin";
  const channel = selectedThread?.channel ?? "web";
  return `
    <section class="hero-composer surface-hero ${compact ? "compact" : ""}">
      <div class="composer-heading">
        <div>
          <span class="eyebrow">Work first</span>
          <h2>${compact ? "Continue this thread" : "What should the agent do?"}</h2>
        </div>
        <span class="context-chip">${continuing ? "Thread context enabled" : "New thread"}</span>
      </div>
      <form data-action="run-agent" class="composer-form">
        <input type="hidden" name="threadMode" value="${continuing ? "continue" : "new"}" />
        ${continuing ? `<input type="hidden" name="threadId" value="${escapeHtml(selectedThread.id)}" />` : ""}
        ${continuing ? `<input type="hidden" name="requesterUserId" value="${escapeHtml(requester)}" />` : ""}
        ${continuing ? `<input type="hidden" name="channel" value="${escapeHtml(channel)}" />` : ""}
        ${continuing
          ? `
            <div class="thread-continuation-meta">
              <span>Thread</span>
              <strong>${escapeHtml(selectedThread.title)}</strong>
              <small>${escapeHtml(requester)} · ${escapeHtml(channel)} · context inherited</small>
            </div>
          `
          : `
            <div class="composer-grid compact-grid">
              <label>
                <span>Requester</span>
                <select name="requesterUserId">
                  ${state.users.length
                    ? state.users
                        .map(
                          (user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)} · ${escapeHtml(user.id)}</option>`,
                        )
                        .join("")
                    : `<option value="user-admin">Admin · user-admin</option>`}
                </select>
              </label>
              <label>
                <span>Source</span>
                <select name="channel">
                  <option value="web">Web console</option>
                  <option value="api">API</option>
                </select>
              </label>
            </div>
          `}
        <textarea name="task" placeholder="Ask for research, code, screenshots, reports, reminders, or a correction to the selected thread." required></textarea>
        <div class="composer-bottom">
          <label class="attach-button">
            <input name="files" type="file" multiple />
            <span>Attach files</span>
          </label>
          <p class="composer-hint">${continuing ? "Using group profile + selected thread summary." : "A new conversation thread will be created."}</p>
          <button type="submit" class="primary-button">Run Agent</button>
        </div>
      </form>
    </section>
  `;
}

function renderContextPreview(thread) {
  return `
    <section class="surface-panel context-preview">
      <div class="section-heading">
        <div>
          <h2>Context Preview</h2>
          <p>Readable context, not raw logs.</p>
        </div>
      </div>
      <div class="context-stack">
        ${contextBlock("Group profile", state.groupProfile?.description || "Default one-group profile for local development.")}
        ${contextBlock("Selected thread", thread ? thread.summary : "No thread selected. A new thread will be created.")}
        ${contextBlock("Memory scope", "Global skills + group memory + requester memory + run-local context.")}
        ${thread?.acceptedFacts?.length ? contextBlock("Accepted facts", thread.acceptedFacts.slice(-3).join("\n")) : ""}
      </div>
    </section>
  `;
}

function contextBlock(title, body, options = {}) {
  return `
    <article class="context-block">
      <span>${title}</span>
      <p>${options.html ? body : escapeHtml(body)}</p>
    </article>
  `;
}

function renderActiveRuns(runs) {
  return `
    <section class="surface-panel">
      <div class="section-heading">
        <div>
          <h2>Active Runs</h2>
          <p>Live work in progress.</p>
        </div>
      </div>
      <div class="run-card-grid">
        ${runs.length
          ? runs.map((run) => renderRunCard(run)).join("")
          : renderEmptyState("No active runs", "Start a task and the live execution will appear here.", "Run Agent")}
      </div>
    </section>
  `;
}

function renderRunCard(run) {
  const currentStep = latestEvent(run)?.title ?? "Waiting for first event";
  return `
    <article class="run-card ${run.status}" data-action="select-run" data-run-id="${run.id}" tabindex="0">
      <div class="run-card-top">
        ${statusBadge(run.status)}
        <span data-live-run-duration="${run.id}">${formatRunDuration(run)}</span>
      </div>
      <h3>${escapeHtml(run.task)}</h3>
      <p>${escapeHtml(currentStep)}</p>
      <div class="progress-line"><span style="width:${runProgress(run)}%"></span></div>
      <div class="card-actions">
        <button type="button" class="ghost-button" data-action="select-run" data-run-id="${run.id}">Open</button>
        <button type="button" class="ghost-button" data-action="open-trace" data-run-id="${run.id}">Trace</button>
      </div>
    </article>
  `;
}

function renderRecentActivity(runs) {
  return `
    <section class="surface-panel">
      <div class="section-heading">
        <div>
          <h2>Recent Activity</h2>
          <p>Runs, conversations, artifacts, and approvals.</p>
        </div>
      </div>
      <div class="activity-feed">
        ${runs.length
          ? runs.map((run) => renderActivityItem(run)).join("")
          : renderEmptyState("No runs yet", "Start your first agent task.", "New Task")}
      </div>
    </section>
  `;
}

function renderActivityItem(run) {
  return `
    <button type="button" class="activity-item" data-action="select-run" data-run-id="${run.id}">
      <span class="activity-icon">${run.status === "completed" ? "✓" : run.status === "failed" ? "!" : run.status === "cancelled" ? "×" : "•"}</span>
      <span class="activity-copy">
        <strong>${escapeHtml(run.task)}</strong>
        <small>${run.channel ?? "web"} · ${run.requesterUserId ?? "user-admin"} · ${formatRelative(run.updatedAt)}</small>
      </span>
      ${statusBadge(run.status)}
    </button>
  `;
}

function renderOperationalInsights() {
  const completed = state.runs.filter((run) => run.status === "completed").length;
  const failed = state.runs.filter((run) => run.status === "failed").length;
  const total = Math.max(1, completed + failed);
  const artifacts = state.runs.flatMap((run) => run.result?.artifacts ?? []).length;
  const toolCalls = state.runs.reduce(
    (sum, run) => sum + (run.events ?? []).filter((event) => event.activity === "tool").length,
    0,
  );
  const metrics = [
    ["Success rate", `${Math.round((completed / total) * 100)}%`, "Completed runs"],
    ["Active runs", String(state.runs.filter((run) => ["queued", "running"].includes(run.status)).length), "In progress"],
    ["Memory hits", String(state.memories.length), "Stored memories"],
    ["Tool calls", String(toolCalls), "Observed events"],
    ["Artifacts", String(artifacts), "Generated files"],
    ["Approvals", String(pendingApprovalCount()), "Pending decisions"],
  ];
  return `
    <section class="surface-panel">
      <div class="section-heading">
        <div>
          <h2>Operational Insights</h2>
          <p>Compact health of the workspace.</p>
        </div>
      </div>
      <div class="metric-card-grid">
        ${metrics
          .map(
            ([label, value, detail]) => `
              <article class="metric-card">
                <span>${label}</span>
                <strong>${value}</strong>
                <small>${detail}</small>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSystemHealth() {
  return `
    <section class="surface-panel compact-health">
      <div>
        <h2>System Health</h2>
        <p>${state.error ? "Some services need attention." : "All systems operational."}</p>
      </div>
      <div class="health-grid">
        ${["App", "Postgres", "Redis", "MinIO", "SearXNG", "LLM"].map((item) => `<span>${item}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderRunsList() {
  return `
    <section class="page-stack">
      ${renderFilterBar("Search runs...", ["Status", "User", "Channel", "Date"])}
      <section class="surface-panel">
        <div class="table-list">
          ${state.runs.length
            ? state.runs.map((run) => renderRunRow(run)).join("")
            : renderEmptyState("No runs yet", "Start your first agent task.", "New Task")}
        </div>
      </section>
    </section>
  `;
}

function renderRunRow(run) {
  const artifacts = run.result?.artifacts?.length ?? 0;
  const tools = (run.events ?? []).filter((event) => event.activity === "tool").length;
  return `
    <button type="button" class="data-row" data-action="select-run" data-run-id="${run.id}">
      <span class="row-title">${escapeHtml(run.task)}</span>
      ${statusBadge(run.status)}
      <span>${run.requesterUserId ?? "user-admin"}</span>
      <span>${run.channel ?? "web"}</span>
      <span data-live-run-duration="${run.id}">${formatRunDuration(run)}</span>
      <span>${tools} tools · ${artifacts} files</span>
      <span>${formatRelative(run.createdAt)}</span>
    </button>
  `;
}

function renderRunWorkspace(run) {
  if (!run) return renderEmptyState("Run not found", "Open a run from the Runs page.", "Runs");
  const timeline = buildTraceNodes(run.events ?? []);
  const artifacts = run.result?.artifacts ?? [];
  const thread = state.conversations.find((candidate) => candidate.id === run.threadId);
  const tierSummary = modelTierSummaryForRun(run);
  const mode = run.result?.complexity?.mode;
  return `
    <section class="run-workspace">
      <header class="run-status-bar">
        <div>
          <h2>${escapeHtml(run.task)}</h2>
          <p>${run.requesterUserId ?? "user-admin"} · ${run.channel ?? "web"} · ${thread?.title ?? "No thread"}</p>
        </div>
        <div class="status-cluster">
          ${statusBadge(run.status)}
          <span data-live-run-duration="${run.id}">${formatRunDuration(run)}</span>
          ${mode ? `<span>${escapeHtml(mode)}</span>` : ""}
          ${tierSummary ? `<span>${escapeHtml(tierSummary)}</span>` : ""}
        </div>
      </header>
      <div class="run-result-layout">
        <section class="result-column">
          ${resultCard("Task Prompt", run.task)}
          ${resultCard("Final Answer", runStatusMessage(run))}
          ${renderArtifactStrip(artifacts)}
          ${thread ? renderComposer({ compact: true, mode: "continue", selectedThread: thread }) : ""}
          <div class="action-row">
            <button type="button" class="primary-button" data-action="continue-thread" data-thread-id="${run.threadId ?? ""}">Continue Thread</button>
            <button type="button" class="ghost-button" data-action="continue-thread" data-thread-id="${run.threadId ?? ""}">Correct Answer</button>
            ${["queued", "running"].includes(run.status) ? `<button type="button" class="danger-button" data-action="cancel-run" data-run-id="${run.id}">Cancel Run</button>` : ""}
            <button type="button" class="ghost-button" data-action="open-trace" data-run-id="${run.id}">Open Trace Lab</button>
          </div>
        </section>
        <aside class="side-panel">
          <div class="section-heading">
            <div>
              <h2>Run Timeline</h2>
              <p>Human-readable execution summary.</p>
            </div>
          </div>
          ${renderTimeline(timeline.slice(0, 8), { compact: true, prioritizeActive: true })}
          <div class="insight-list">
            ${miniInsight("Memory hits", `${(run.events ?? []).filter((event) => event.activity === "memory").length}`)}
            ${miniInsight("Tool calls", `${(run.events ?? []).filter((event) => event.activity === "tool").length}`)}
            ${miniInsight("Model usage", unique((run.events ?? []).map(modelTierFor).filter(Boolean)).join(", ") || "n/a")}
          </div>
        </aside>
      </div>
      <section class="surface-panel">
        <div class="tabs-row">
          <span class="active">Artifacts</span>
          <span>Outbound Actions</span>
          <span>Errors</span>
          <span>Raw Details</span>
        </div>
        ${renderArtifactStrip(artifacts, true)}
      </section>
    </section>
  `;
}

function resultCard(title, content) {
  return `
    <article class="result-card">
      <span>${title}</span>
      <div class="markdown-body">${renderMarkdown(content)}</div>
    </article>
  `;
}

function runStatusMessage(run) {
  if (run.status === "failed") return run.error ?? "Run failed.";
  if (run.status === "cancelled") return run.error ?? "Run cancelled.";
  return run.result?.finalAnswer ?? "Agent is working...";
}

function renderArtifactStrip(artifacts, expanded = false) {
  return `
    <section class="artifact-strip ${expanded ? "expanded" : ""}">
      <div class="section-heading">
        <div>
          <h2>Artifacts</h2>
          <p>${artifacts.length} generated or attached files.</p>
        </div>
      </div>
      <div class="artifact-grid">
        ${artifacts.length
          ? artifacts.map(renderArtifactCard).join("")
          : renderEmptyState("No artifacts", "Generated files will appear here.", "Artifacts")}
      </div>
    </section>
  `;
}

function renderArtifactCard(artifact) {
  const isImage = artifact.mimeType?.startsWith("image/");
  const preview = artifactPreview(artifact);
  const quality = renderArtifactQuality(artifact.quality);
  return `
    <a class="artifact-card" href="${artifact.url}" target="_blank" rel="noreferrer">
      <span class="artifact-preview ${isImage ? "image" : "text"}">
        ${isImage ? `<img src="${artifact.url}" alt="${escapeHtml(artifact.filename)}" loading="lazy" />` : preview}
      </span>
      <span class="artifact-copy">
        <strong>${escapeHtml(artifact.filename)}</strong>
        <small>${artifact.kind} · ${artifact.mimeType} · ${formatBytes(artifact.sizeBytes)}</small>
        ${artifact.description ? `<em>${escapeHtml(truncate(artifact.description, 120))}</em>` : ""}
        ${quality}
      </span>
    </a>
  `;
}

function renderArtifactQuality(quality) {
  if (!quality || !Array.isArray(quality.checks) || !quality.checks.length) return "";
  const firstFailed = quality.checks.find((check) => !check.ok);
  const firstWarning = quality.checks.find((check) => check.warnings?.length);
  const primary = firstFailed ?? firstWarning ?? quality.checks[0];
  const label =
    quality.status === "passed" ? "QA passed" : quality.status === "warning" ? "QA warning" : "QA failed";
  return `
    <span class="artifact-quality ${escapeHtml(quality.status)}" title="${escapeHtml(primary?.reason ?? label)}">
      ${escapeHtml(label)}
    </span>
  `;
}

function artifactPreview(artifact) {
  const preview = typeof artifact.contentPreview === "string" ? artifact.contentPreview.trim() : "";
  if (preview) {
    if (isDatasetArtifact(artifact)) return renderDatasetPreview(preview);
    return `<pre>${escapeHtml(truncate(preview, 520))}</pre>`;
  }
  if (artifact.mimeType === "application/pdf") return `<span class="artifact-icon">PDF</span>`;
  if (artifact.mimeType?.includes("json")) return `<span class="artifact-icon">JSON</span>`;
  if (isDatasetArtifact(artifact)) return `<span class="artifact-icon">DATA</span>`;
  if (isSourceArtifact(artifact)) return `<span class="artifact-icon">CODE</span>`;
  if (artifact.mimeType?.startsWith("text/")) return `<span class="artifact-icon">TEXT</span>`;
  if (artifact.mimeType?.includes("zip") || artifact.mimeType?.includes("tar")) return `<span class="artifact-icon">ZIP</span>`;
  return `<span class="artifact-icon">FILE</span>`;
}

function renderDatasetPreview(preview) {
  const lines = preview.split(/\r?\n/).filter(Boolean).slice(0, 5);
  const rows = lines.map((line) => line.split(line.includes("\t") ? "\t" : ",").slice(0, 5));
  if (!rows.length) return `<pre>${escapeHtml(truncate(preview, 520))}</pre>`;

  return `
    <table class="artifact-table-preview">
      <tbody>
        ${rows
          .map(
            (row, index) => `
              <tr class="${index === 0 ? "header" : ""}">
                ${row.map((cell) => `<td>${escapeHtml(truncate(cell.trim(), 36))}</td>`).join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function isDatasetArtifact(artifact) {
  const mimeType = artifact.mimeType ?? "";
  const filename = artifact.filename ?? "";
  return mimeType === "text/csv" || mimeType === "text/tab-separated-values" || /\.(csv|tsv)$/i.test(filename);
}

function isSourceArtifact(artifact) {
  const mimeType = artifact.mimeType ?? "";
  const filename = artifact.filename ?? "";
  return (
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|html|sql|sh|md|yaml|yml)$/i.test(filename)
  );
}

function renderTraceLab(run) {
  if (!run) return renderEmptyState("No run selected", "Open a run to inspect its trace.", "Runs");
  const nodes = buildTraceNodes(run.events ?? []);
  const filteredNodes = applyTraceFilters(nodes);
  const selected = filteredNodes.find((node) => node.spanId === state.selectedSpanId) ?? filteredNodes[0] ?? nodes[0];
  const filteredEvents = filterEventsForTrace(run.events ?? [], filteredNodes);
  return `
    <section class="trace-page">
      <div class="trace-toolbar surface-panel">
        <button type="button" class="ghost-button trace-back-button" data-action="select-run" data-run-id="${run.id}">
          Back to run
        </button>
        <select aria-label="Run selector" data-action="select-trace-run">
          ${state.runs
            .map((candidate) => `<option value="${candidate.id}" ${candidate.id === run.id ? "selected" : ""}>${escapeHtml(candidate.task)}</option>`)
            .join("")}
        </select>
        <div class="trace-tabs">
          ${["timeline", "graph", "logs"]
            .map(
              (mode) => `
                <button type="button" class="${state.traceMode === mode ? "active" : ""}" data-action="set-trace-mode" data-trace-mode="${mode}">
                  ${titleCase(mode)}
                </button>
              `,
            )
            .join("")}
        </div>
        <div class="trace-filters" aria-label="Trace filters">
          ${renderTraceFilterSelect("Actor", "actor", traceFilterOptions(nodes, "actor"))}
          ${renderTraceFilterSelect("Activity", "activity", traceFilterOptions(nodes, "activity"))}
          ${renderTraceFilterSelect("Status", "status", traceFilterOptions(nodes, "status"))}
          ${renderTraceFilterSelect("Tool", "tool", traceFilterOptions(nodes, "tool"))}
          ${renderTraceFilterSelect("Model", "modelTier", traceFilterOptions(nodes, "modelTier"))}
        </div>
      </div>
      <div class="trace-layout">
        <section class="surface-panel trace-view">
          ${state.traceMode === "timeline" ? renderTimeline(filteredNodes, { prioritizeActive: true }) : ""}
          ${state.traceMode === "graph" ? renderTraceGraph(filteredNodes) : ""}
          ${state.traceMode === "logs" ? renderTraceLogs(filteredEvents) : ""}
        </section>
        <aside class="surface-panel inspector-panel">
          ${renderInspector(selected)}
        </aside>
      </div>
    </section>
  `;
}

function renderTraceRunDirectory() {
  const runs = [...state.runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return `
    <section class="page-stack">
      <section class="surface-hero trace-directory-hero">
        <div>
          <span class="eyebrow">Trace Lab</span>
          <h2>Choose a run to inspect</h2>
          <p>Open a run trace directly. Timeline, graph, logs, filters, and inspector will stay scoped to the selected execution.</p>
        </div>
        <span class="context-chip">${runs.length} runs</span>
      </section>
      <section class="surface-panel">
        <div class="trace-run-list">
          ${runs.length
            ? runs.map(renderTraceRunItem).join("")
            : renderEmptyState("No runs yet", "Start a task from Dashboard, then inspect it here.", "Dashboard")}
        </div>
      </section>
    </section>
  `;
}

function renderTraceRunItem(run) {
  const events = run.events?.length ?? 0;
  const tools = (run.events ?? []).filter((event) => event.activity === "tool").length;
  return `
    <button type="button" class="trace-run-item" data-action="open-trace" data-run-id="${run.id}">
      <span>
        <strong>${escapeHtml(run.task)}</strong>
        <small>${escapeHtml(run.requesterUserId ?? "user-admin")} · ${escapeHtml(run.channel ?? "web")} · ${formatRelative(run.createdAt)}</small>
      </span>
      ${statusBadge(run.status)}
      <span>${events} events</span>
      <span>${tools} tools</span>
      <span>Open trace</span>
    </button>
  `;
}

function renderTraceFilterSelect(label, key, options) {
  return `
    <label>
      <span>${label}</span>
      <select data-action="set-trace-filter" data-filter-key="${key}" aria-label="${label} filter">
        <option value="all">All</option>
        ${options
          .map(
            (option) => `
              <option value="${escapeHtml(option)}" ${state.traceFilters[key] === option ? "selected" : ""}>
                ${escapeHtml(option)}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

function renderTimeline(nodes, options = {}) {
  const visibleNodes = options.prioritizeActive ? orderTraceNodes(nodes, true) : orderTraceNodes(nodes, false);
  return `
    <div class="timeline ${options.compact ? "compact" : ""}">
      ${nodes.length
        ? visibleNodes
            .map(
              (node) => `
                <button type="button" class="timeline-step ${node.status}" data-action="select-span" data-span-id="${node.spanId}">
                  <span class="timeline-marker"></span>
                  <span class="timeline-content">
                    <strong>${escapeHtml(node.title)}</strong>
                    <small>
                      ${node.actor} · ${node.activity} ·
                      <span data-live-node-duration="${node.spanId}">${formatNodeDuration(node)}</span>
                      ${modelTierFor(node) ? ` · Tier ${escapeHtml(modelTierFor(node))}` : ""}
                    </small>
                    ${node.parentTitle ? `<small class="caller-line">called by ${escapeHtml(node.parentTitle)}</small>` : ""}
                    ${node.detail ? `<em>${escapeHtml(truncate(node.detail, 140))}</em>` : ""}
                  </span>
                  ${statusBadge(node.status)}
                </button>
              `,
            )
            .join("")
        : renderEmptyState("No trace events yet", "Events will appear as the agent works.", "Trace")}
    </div>
  `;
}

function renderTraceGraph(nodes) {
  const orderedNodes = orderTraceNodes(nodes, false);
  const depths = traceGraphDepths(orderedNodes);
  const columns = traceGraphColumns(orderedNodes, depths);
  const grouped = groupBy(orderedNodes, (node) => traceGraphColumnFor(node, state.traceGraphLayout, depths));
  return `
    <div class="graph-canvas" data-graph-canvas>
      <svg class="graph-edge-layer" data-graph-edge-layer aria-hidden="true"></svg>
      <div class="trace-graph-layout-switch" aria-label="Trace graph layout">
        ${[
          ["category", "Category"],
          ["depth", "Call depth"],
        ]
          .map(
            ([layout, label]) => `
              <button
                type="button"
                class="${state.traceGraphLayout === layout ? "active" : ""}"
                data-action="set-trace-graph-layout"
                data-trace-graph-layout="${layout}"
              >
                ${label}
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="graph-legend" aria-label="Graph edge legend">
        <span><i class="legend-line solid"></i> Direct call</span>
        <span><i class="legend-line dashed"></i> Dependency: waits for upstream result</span>
        <span><i class="legend-line failed"></i> Calls a failed span</span>
      </div>
      <div class="graph-board" data-graph-board style="--graph-column-count: ${columns.length}">
        ${columns
          .map(
            (column) => `
              <section class="graph-column">
                <h3>${column}</h3>
                ${(grouped.get(column) ?? [])
                  .map(
                    (node) => `
                      <button
                        type="button"
                        class="graph-node ${node.status}"
                        data-action="select-span"
                        data-span-id="${node.spanId}"
                        data-parent-span-id="${node.parentSpanId ?? ""}"
                        data-dependency-span-ids="${node.dependencySpanIds.join(",")}"
                      >
                        <span class="graph-node-topline">
                          ${statusBadge(node.status)}
                          ${modelTierFor(node) ? `<span class="tier-badge">Tier ${escapeHtml(modelTierFor(node))}</span>` : ""}
                        </span>
                        <strong>${escapeHtml(node.title)}</strong>
                        <small>${escapeHtml(node.actor)} · ${escapeHtml(node.activity)} · ${formatNodeDuration(node)}</small>
                        ${node.dependencySpanIds.length
                          ? `<small class="caller-line">waits for ${node.dependencySpanIds.length} dependency span(s)</small>`
                          : ""}
                        <span class="graph-category-chip">${escapeHtml(graphColumn(node))}</span>
                      </button>
                    `,
                  )
                  .join("") || `<p class="muted">No spans</p>`}
              </section>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTraceLogs(events) {
  return `
    <div class="log-list">
      ${events.length
        ? events
            .map(
              (event) => `
                <article class="log-row">
                  <time>${new Date(event.timestamp).toLocaleTimeString()}</time>
                  ${statusBadge(event.status)}
                  <strong>${event.actor}</strong>
                  <span>${escapeHtml(event.title)}</span>
                </article>
              `,
            )
            .join("")
        : renderEmptyState("No logs", "Trace logs will appear here.", "Logs")}
    </div>
  `;
}

function renderInspector(node) {
  if (!node) return renderEmptyState("Nothing selected", "Select a trace step.", "Trace");
  return `
    <div class="inspector-stack">
      <span class="eyebrow">Inspector</span>
      <h2>${escapeHtml(node.title)}</h2>
      <div class="inspector-meta">
        ${statusBadge(node.status)}
        <span>${node.actor}</span>
        <span>${node.activity}</span>
        <span data-live-node-duration="${node.spanId}">${formatNodeDuration(node)}</span>
        ${modelTierFor(node) ? `<span>Tier ${escapeHtml(modelTierFor(node))}</span>` : ""}
      </div>
      ${contextBlock("Input summary", node.parentTitle ? `Called by ${node.parentTitle}` : "Root coordinator span.")}
      ${contextBlock("Output summary", node.detail || "No detail payload.")}
      ${node.dependencySpanIds.length ? contextBlock("Dependency spans", node.dependencySpanIds.join("\n")) : ""}
      ${renderInspectorCallFrame(node)}
      ${renderInspectorSelfCheck(node)}
      ${renderInspectorEvidence(node)}
      ${renderSpanToolRequestForm(node)}
    </div>
  `;
}

function renderInspectorCallFrame(node) {
  const callFrame = callFrameFromPayload(node.payload);
  if (!callFrame) return "";
  return `
    <section class="context-block call-frame-card">
      <div class="call-frame-heading">
        <span>Agent call frame</span>
        <strong>${escapeHtml(callFrame.status ?? node.status)}</strong>
      </div>
      <dl class="call-frame-meta">
        <div><dt>Frame</dt><dd>${escapeHtml(callFrame.id ?? "unknown")}</dd></div>
        <div><dt>Role</dt><dd>${escapeHtml(callFrame.role ?? node.actor)}</dd></div>
        <div><dt>Actor</dt><dd>${escapeHtml(callFrame.actor ?? node.actor)}</dd></div>
        <div><dt>Depth</dt><dd>${escapeHtml(String(callFrame.depth ?? "n/a"))}</dd></div>
        <div><dt>Caller span</dt><dd>${escapeHtml(callFrame.parentSpanId ?? node.parentSpanId ?? "root")}</dd></div>
        <div><dt>Model tier</dt><dd>${escapeHtml(callFrame.modelTier ?? modelTierFor(node) ?? "not set")}</dd></div>
      </dl>
      ${callFrame.localTask ? `<details open><summary>Local task</summary><p>${escapeHtml(callFrame.localTask)}</p></details>` : ""}
      ${callFrame.outputContract ? `<details><summary>Output contract</summary><p>${escapeHtml(callFrame.outputContract)}</p></details>` : ""}
      ${callFrame.outputSummary ? `<details><summary>Returned summary</summary><p>${escapeHtml(callFrame.outputSummary)}</p></details>` : ""}
    </section>
  `;
}

function renderInspectorSelfCheck(node) {
  const selfCheck = selfCheckFromPayload(node.payload);
  if (!selfCheck) return "";
  const checks = Array.isArray(selfCheck.checks) ? selfCheck.checks : [];
  const warnings = Array.isArray(selfCheck.warnings) ? selfCheck.warnings : [];
  return `
    <section class="context-block self-check-card ${selfCheck.readyToReturn ? "ready" : "blocked"}">
      <div class="self-check-heading">
        <span>Return self-check</span>
        <strong>${selfCheck.readyToReturn ? "ready" : "blocked"}</strong>
      </div>
      <div class="self-check-metrics">
        <span>${escapeHtml(String(selfCheck.evidenceCount ?? 0))} evidence</span>
        <span>${escapeHtml(String(selfCheck.artifactCount ?? 0))} artifacts</span>
        <span>${escapeHtml(formatRelative(selfCheck.checkedAt ?? node.lastTimestamp))}</span>
      </div>
      <ul class="self-check-list">
        ${checks.length
          ? checks
              .map(
                (check) => `
                  <li class="${check.ok ? "ok" : "fail"}">
                    <strong>${check.ok ? "pass" : "fail"}</strong>
                    <span>${escapeHtml(check.name ?? "check")}</span>
                    <small>${escapeHtml(check.reason ?? "")}</small>
                  </li>
                `,
              )
              .join("")
          : `<li class="fail"><strong>missing</strong><span>No structured checks</span></li>`}
      </ul>
      ${warnings.length
        ? `<details open><summary>Warnings</summary><p>${warnings.map((warning) => escapeHtml(warning)).join("<br>")}</p></details>`
        : ""}
      ${selfCheck.limitations?.length
        ? `<details><summary>Limitations</summary><p>${selfCheck.limitations.map((item) => escapeHtml(item)).join("<br>")}</p></details>`
        : ""}
    </section>
  `;
}

function renderInspectorEvidence(node) {
  const blocks = [];
  const memories = memoryEntriesFromPayload(node.payload);
  if (memories.length) {
    blocks.push(
      contextBlock(
        "Memory hits",
        memories
          .slice(0, 5)
          .map((memory) => `${memory.title}${memory.summary ? `\n${memory.summary}` : ""}`)
          .join("\n\n"),
      ),
    );
  }

  const artifacts = artifactsFromPayload(node.payload);
  if (artifacts.length) {
    blocks.push(
      `<section class="context-block inspector-artifacts">
        <h3>Artifacts</h3>
        <div class="artifact-grid compact-grid">${artifacts.map(normalizeArtifactForCard).map(renderArtifactCard).join("")}</div>
      </section>`,
    );
  }

  const toolSummary = toolSummaryFromPayload(node.payload);
  if (toolSummary) {
    blocks.push(contextBlock("Tool evidence", toolSummary));
  }

  return blocks.join("");
}

function callFrameFromPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  return payload.callFrame && typeof payload.callFrame === "object" ? payload.callFrame : undefined;
}

function selfCheckFromPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  return payload.selfCheck && typeof payload.selfCheck === "object" ? payload.selfCheck : undefined;
}

function renderSpanToolRequestForm(node) {
  const relatedTool = findToolForSpan(node);
  const capability = relatedTool?.capabilities?.[0] ?? inferCapabilityFromSpan(node);
  const activeVersion = relatedTool
    ? normalizeToolVersions(relatedTool).find((version) => version.active)?.version ?? relatedTool.version
    : "";
  const reason = [
    `Trace span needs operator review or tool improvement.`,
    `Run: ${activeRun()?.id ?? "unknown"}`,
    `Span: ${node.spanId}`,
    `Title: ${node.title}`,
    `Actor: ${node.actor}`,
    `Activity: ${node.activity}`,
    `Status: ${node.status}`,
    node.parentTitle ? `Called by: ${node.parentTitle}` : "",
    node.detail ? `Observed output/error:\n${truncate(node.detail, 1200)}` : "",
    `Context note: classify whether this is tool logic, tool contract, prompt/planning, site limitation, credential/policy limitation, or an external blocker before rebuilding.`,
  ]
    .filter(Boolean)
    .join("\n");

  return `
    <details class="rework-box span-request-box">
      <summary>Create tool request / bug from this span</summary>
      <form data-action="create-tool-build-request" class="rework-form">
        <input type="hidden" name="sourceRunId" value="${escapeHtml(activeRun()?.id ?? "")}" />
        <input type="hidden" name="sourceSpanId" value="${escapeHtml(node.spanId)}" />
        <input type="hidden" name="taskSummary" value="${escapeHtml(activeRun()?.task ?? "")}" />
        <input type="hidden" name="capability" value="${escapeHtml(capability)}" />
        <input type="hidden" name="displayName" value="${escapeHtml(relatedTool?.displayName || relatedTool?.name || "")}" />
        <input type="hidden" name="desiredToolName" value="${escapeHtml(relatedTool?.name || "")}" />
        <input type="hidden" name="replacesToolName" value="${escapeHtml(relatedTool?.name || "")}" />
        <input type="hidden" name="replacesVersion" value="${escapeHtml(activeVersion || "")}" />
        <input type="hidden" name="startupMode" value="${escapeHtml(relatedTool?.startupMode || "on-demand")}" />
        <input type="hidden" name="feedback" value="${escapeHtml(reason)}" />
        <label>
          <span>Context and requested fix</span>
          <textarea name="reason" required>${escapeHtml(reason)}</textarea>
        </label>
        <label>
          <span>QA criteria</span>
          <textarea name="qaCriteria" rows="3">Reproduce the observed failure.
Add a regression test for the corrected behavior.
Prove the produced result is useful evidence and does not leak credentials.</textarea>
        </label>
        <button type="submit" class="ghost-button">Create contextual request</button>
      </form>
    </details>
  `;
}

function findToolForSpan(node) {
  const candidates = [
    node.actor,
    node.payload?.tool,
    node.payload?.toolName,
  ]
    .filter(Boolean)
    .map(String);
  return state.tools.find((tool) => candidates.includes(tool.name));
}

function renderConversationsList() {
  return `
    <section class="page-stack">
      ${renderFilterBar("Search conversations...", ["User", "Channel", "Status"])}
      <div class="conversation-grid">
        ${state.conversations.length
          ? state.conversations.map(renderConversationCard).join("")
          : renderEmptyState("No conversations yet", "Create a task or connect Telegram.", "New Task")}
      </div>
    </section>
  `;
}

function renderConversationCard(thread) {
  return `
    <article class="conversation-card" data-action="select-thread" data-thread-id="${thread.id}" tabindex="0">
      <div class="card-topline">
        <span>${thread.channel}</span>
        <span>${formatRelative(thread.updatedAt)}</span>
      </div>
      <h3>${escapeHtml(thread.title)}</h3>
      <p>${escapeHtml(truncate(thread.summary, 240))}</p>
      <div class="conversation-meta-grid">
        <span>${thread.messages?.length ?? 0} messages</span>
        <span>${thread.acceptedFacts?.length ?? 0} facts</span>
        <span>${thread.artifactIds?.length ?? 0} files</span>
      </div>
      <div class="card-actions">
        <button type="button" class="primary-button" data-action="select-thread" data-thread-id="${thread.id}">Open</button>
        <button type="button" class="ghost-button" data-action="continue-thread" data-thread-id="${thread.id}">Continue</button>
        <button type="button" class="ghost-button danger-button" data-action="delete-thread" data-thread-id="${thread.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderConversationDetail(thread) {
  if (!thread) return renderEmptyState("Conversation not found", "Open a thread from Conversations.", "Conversations");
  const threadRuns = state.runs.filter((run) => run.threadId === thread.id);
  return `
    <section class="conversation-detail">
      <aside class="thread-runs surface-panel">
        <h2>Thread Runs</h2>
        ${threadRuns.length ? threadRuns.map((run) => renderMiniRun(run)).join("") : renderEmptyState("No runs", "Runs will appear here.", "Run")}
      </aside>
      <section class="message-column surface-panel">
        <div class="section-heading">
          <div>
            <h2>${escapeHtml(thread.title)}</h2>
            <p>${thread.requesterUserId} · ${thread.channel} · ${thread.status}</p>
          </div>
          <div class="card-actions">
            <button type="button" class="primary-button" data-action="continue-thread" data-thread-id="${thread.id}">Continue Thread</button>
            <button type="button" class="ghost-button danger-button" data-action="delete-thread" data-thread-id="${thread.id}">Delete Thread</button>
          </div>
        </div>
        <div class="message-list">
          ${(thread.messages ?? [])
            .map((message) => {
              const run = state.runs.find((candidate) => candidate.id === message.runId);
              return `
                <article class="message-bubble ${message.role}">
                  <span>${message.role}</span>
                  <div class="markdown-body">${renderMarkdown(message.content)}</div>
                  ${renderMessageArtifacts(message, run)}
                  <small>${formatRelative(message.createdAt)}</small>
                </article>
              `;
            })
            .join("") || renderEmptyState("No messages", "Messages will appear as runs complete.", "Thread")}
        </div>
        ${renderComposer({ compact: true, mode: "continue", selectedThread: thread })}
      </section>
      <aside class="thread-context surface-panel">
        <h2>Context Package</h2>
        ${contextBlock("Summary", thread.summary)}
        ${contextBlock("Accepted facts", thread.acceptedFacts?.join("\n") || "No accepted facts yet.")}
        ${contextBlock("Rejected attempts", thread.rejectedAttempts?.join("\n") || "No rejected attempts.")}
        ${contextBlock("Open questions", thread.openQuestions?.join("\n") || "No open questions.")}
        ${contextBlock("Linked artifacts", renderThreadArtifactSummary(thread))}
      </aside>
    </section>
  `;
}

function renderMessageArtifacts(message, run) {
  const artifacts = run?.result?.artifacts ?? [];
  const visibleArtifacts = artifacts.filter((artifact) => {
    if (message.role === "user") return artifact.kind === "input";
    if (message.role === "assistant") return artifact.kind === "output";
    return true;
  });
  if (!visibleArtifacts.length) return "";

  return `
    <div class="message-artifacts">
      ${visibleArtifacts.map(renderCompactArtifactLink).join("")}
    </div>
  `;
}

function renderThreadArtifactSummary(thread) {
  const artifacts = state.runs
    .filter((run) => run.threadId === thread.id)
    .flatMap((run) => run.result?.artifacts ?? [])
    .filter((artifact) => thread.artifactIds?.includes(artifact.id));
  if (!artifacts.length) return "No linked artifacts yet.";
  return artifacts.map((artifact) => `${artifact.filename} (${artifact.mimeType}) ${artifact.url}`).join("\n");
}

function renderCompactArtifactLink(artifact) {
  const isImage = artifact.mimeType?.startsWith("image/");
  const label = artifactTypeLabel(artifact);
  return `
    <a class="artifact-chip compact" href="${artifact.url}" target="_blank" rel="noreferrer">
      ${isImage ? `<img src="${artifact.url}" alt="${escapeHtml(artifact.filename)}" loading="lazy" />` : `<span class="artifact-chip-icon">${escapeHtml(label)}</span>`}
      <span class="artifact-chip-copy">
        <strong>${escapeHtml(artifact.filename)}</strong>
        <span>${escapeHtml(artifact.mimeType)} · ${formatBytes(artifact.sizeBytes ?? 0)}</span>
      </span>
    </a>
  `;
}

function artifactTypeLabel(artifact) {
  if (artifact.mimeType === "application/pdf") return "PDF";
  if (artifact.mimeType?.includes("json")) return "JSON";
  if (isDatasetArtifact(artifact)) return "DATA";
  if (isSourceArtifact(artifact)) return "CODE";
  if (artifact.mimeType?.includes("zip") || artifact.mimeType?.includes("tar")) return "ZIP";
  if (artifact.mimeType?.startsWith("text/")) return "TEXT";
  return "FILE";
}

function renderMiniRun(run) {
  return `
    <button type="button" class="mini-run" data-action="select-run" data-run-id="${run.id}">
      <strong>${escapeHtml(run.task)}</strong>
      <small>${run.status} · <span data-live-run-duration="${run.id}">${formatRunDuration(run)}</span></small>
    </button>
  `;
}

function renderMemoryPage() {
  const filtered = filterMemoriesForView(state.memories);
  const selected =
    filtered.find((memory) => memory.id === state.selectedMemoryId) ??
    state.memories.find((memory) => memory.id === state.selectedMemoryId) ??
    filtered[0];
  const reviewQueue = state.memories.filter((memory) => normalizeMemoryStatus(memory.status) === "proposed");
  const accepted = state.memories.filter((memory) => normalizeMemoryStatus(memory.status) === "accepted");
  const rejected = state.memories.filter((memory) => normalizeMemoryStatus(memory.status) === "rejected");
  const archived = state.memories.filter((memory) => normalizeMemoryStatus(memory.status) === "archived");
  return `
    <section class="memory-layout">
      <section class="page-stack">
        <section class="surface-hero">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Knowledge layer</span>
              <h2>Scoped memory</h2>
              <p>Accepted facts are available to agents. Proposed facts wait for review, and rejected facts stay visible for audit without entering retrieval.</p>
            </div>
            <button type="button" class="ghost-button" data-action="rebuild-memory-embeddings">Rebuild embeddings</button>
          </div>
          <div class="memory-metrics">
            ${miniInsight("Accepted", String(accepted.length))}
            ${miniInsight("Review queue", String(reviewQueue.length))}
            ${miniInsight("Blocked proposals", String(state.memoryReviews.filter((review) => review.status === "blocked").length))}
            ${miniInsight("Rejected", String(rejected.length))}
            ${miniInsight("Archived", String(archived.length))}
          </div>
        </section>
        <div class="tabs-row memory-tabs">
          ${renderMemoryFilterTab("all", "All Memory", state.memories.length)}
          ${renderMemoryFilterTab("proposed", "Review Queue", reviewQueue.length)}
          ${renderMemoryFilterTab("accepted", "Accepted", accepted.length)}
          ${renderMemoryFilterTab("rejected", "Rejected", rejected.length)}
          ${renderMemoryFilterTab("archived", "Archived", archived.length)}
        </div>
        <section class="memory-scope-summary">
          ${["global", "group", "user", "thread", "run"]
            .map((scope) => renderMemoryScopeMetric(scope, state.memories.filter((memory) => memoryScopeOf(memory) === scope).length))
            .join("")}
        </section>
        ${
          reviewQueue.length
            ? `<div class="review-strip">
                <span class="eyebrow">Review queue</span>
                ${reviewQueue.slice(0, 3).map(renderMemoryReviewItem).join("")}
              </div>`
            : ""
        }
        ${filtered.length
          ? renderMemoryScopeSections(filtered)
          : renderEmptyState("No memory in this view", "Change the filter or approve proposed memories.", "Memory")}
      </section>
      <aside class="surface-panel inspector-panel">
        ${selected ? renderMemoryDetail(selected) : renderEmptyState("No memory selected", "Stored lessons and facts will appear here.", "Memory")}
      </aside>
    </section>
  `;
}

function renderMemoryFilterTab(id, label, count) {
  return `
    <button type="button" class="${state.memoryFilter === id ? "active" : ""}" data-action="set-memory-filter" data-memory-filter="${id}">
      ${escapeHtml(label)}
      <small>${count}</small>
    </button>
  `;
}

function renderMemoryScopeMetric(scope, count) {
  return `
    <div class="scope-metric">
      <span>${escapeHtml(scope)}</span>
      <strong>${count}</strong>
    </div>
  `;
}

function renderMemoryScopeSections(memories) {
  return ["global", "group", "user", "thread", "run"]
    .map((scope) => {
      const scoped = memories.filter((memory) => memoryScopeOf(memory) === scope);
      if (!scoped.length) return "";
      return `
        <section class="memory-scope-section">
          <div class="section-heading">
            <div>
              <span class="eyebrow">${escapeHtml(scope)} scope</span>
              <h3>${memoryScopeTitle(scope)}</h3>
            </div>
            <span class="context-chip">${scoped.length} item${scoped.length === 1 ? "" : "s"}</span>
          </div>
          <div class="card-grid memory-card-grid">
            ${scoped.map(renderMemoryCard).join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function renderMemoryCard(memory) {
  const status = normalizeMemoryStatus(memory.status);
  const retrievalImpact =
    status === "accepted"
      ? "available to matching runs"
      : status === "proposed"
        ? "waiting for review"
        : "excluded from retrieval";
  return `
    <article class="knowledge-card ${state.selectedMemoryId === memory.id ? "selected" : ""}" data-action="select-memory" data-memory-id="${memory.id}" tabindex="0">
      <div class="card-topline">
        <span>${escapeHtml(formatMemoryScope(memory))}</span>
        <span>${formatRelative(memory.createdAt)}</span>
      </div>
      <h3>${escapeHtml(memory.title)}</h3>
      <p>${escapeHtml(memory.summary)}</p>
      <div class="tag-row">
        <span>${escapeHtml(status)}</span>
        <span>${formatConfidence(memory.confidence)}</span>
        <span>${escapeHtml(memory.sensitivity ?? "normal")}</span>
      </div>
      <small class="retrieval-note">${escapeHtml(retrievalImpact)}</small>
      <div class="tag-row">${(memory.tags ?? []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      <button type="button" class="ghost-button" data-action="select-memory" data-memory-id="${memory.id}">Inspect</button>
    </article>
  `;
}

function renderMemoryDetail(memory) {
  const status = normalizeMemoryStatus(memory.status);
  return `
    <div class="inspector-stack">
      <span class="eyebrow">Memory detail</span>
      <h2>${escapeHtml(memory.title)}</h2>
      <div class="inspector-meta">
        <span>${escapeHtml(formatMemoryScope(memory))}</span>
        <span>${escapeHtml(status)}</span>
        <span>${formatConfidence(memory.confidence)}</span>
        <span>${escapeHtml(memory.sensitivity ?? "normal")}</span>
        <span>${formatRelative(memory.createdAt)}</span>
      </div>
      ${contextBlock("Retrieval impact", memoryRetrievalImpact(memory))}
      ${renderMemoryProposalReview(memory)}
      ${renderMemoryPolicySimulation(memory)}
      ${contextBlock("Summary", memory.summary || "No summary.")}
      ${contextBlock("Reusable procedure", memory.reusableProcedure || "No procedure recorded.")}
      ${contextBlock("Tags", (memory.tags ?? []).join(", ") || "No tags.")}
      ${contextBlock("Evidence", (memory.evidence ?? []).join("\n") || "No evidence attached.")}
      ${memory.sourceRunId ? contextBlock("Source run", `<a href="#/run/${encodeURIComponent(memory.sourceRunId)}">${escapeHtml(memory.sourceRunId)}</a>`, { html: true }) : ""}
      ${memory.sourceThreadId ? contextBlock("Source thread", `<a href="#/conversation/${encodeURIComponent(memory.sourceThreadId)}">${escapeHtml(memory.sourceThreadId)}</a>`, { html: true }) : ""}
      <div class="card-actions">
        ${status !== "accepted" ? `<button type="button" class="ghost-button" data-action="update-memory-status" data-memory-id="${memory.id}" data-memory-status="accepted">Accept</button>` : ""}
        ${status !== "rejected" ? `<button type="button" class="ghost-button danger-button" data-action="update-memory-status" data-memory-id="${memory.id}" data-memory-status="rejected">Reject</button>` : ""}
        ${status !== "archived" ? `<button type="button" class="ghost-button" data-action="update-memory-status" data-memory-id="${memory.id}" data-memory-status="archived">Archive</button>` : ""}
      </div>
      ${renderMemoryEditForm(memory)}
    </div>
  `;
}

function renderMemoryEditForm(memory) {
  return `
    <form data-action="save-memory" class="memory-edit-form">
      <input type="hidden" name="memoryId" value="${escapeHtml(memory.id)}" />
      <div class="section-heading compact-heading">
        <div>
          <span class="eyebrow">Edit memory</span>
          <h3>Retrieval contract</h3>
        </div>
        <button type="submit" class="ghost-button">Save memory</button>
      </div>
      <label>
        <span>Title</span>
        <input name="title" value="${escapeHtml(memory.title)}" />
      </label>
      <div class="form-grid two">
        <label>
          <span>Scope</span>
          <select name="scope">
            ${["global", "group", "user", "thread", "run"].map((scope) => renderSelectOption(scope, scope, memoryScopeOf(memory))).join("")}
          </select>
        </label>
        <label>
          <span>Scope id</span>
          <input name="scopeId" placeholder="empty for global" value="${escapeHtml(memory.scopeId ?? "")}" />
        </label>
        <label>
          <span>Status</span>
          <select name="status">
            ${["proposed", "accepted", "rejected", "archived"].map((status) => renderSelectOption(status, status, normalizeMemoryStatus(memory.status))).join("")}
          </select>
        </label>
        <label>
          <span>Sensitivity</span>
          <select name="sensitivity">
            ${["normal", "sensitive", "private"].map((sensitivity) => renderSelectOption(sensitivity, sensitivity, memory.sensitivity ?? "normal")).join("")}
          </select>
        </label>
      </div>
      <label>
        <span>Confidence</span>
        <input name="confidence" type="number" min="0" max="1" step="0.01" value="${Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.75}" />
      </label>
      <label>
        <span>Summary</span>
        <textarea name="summary" rows="4">${escapeHtml(memory.summary ?? "")}</textarea>
      </label>
      <label>
        <span>Reusable procedure</span>
        <textarea name="reusableProcedure" rows="4">${escapeHtml(memory.reusableProcedure ?? "")}</textarea>
      </label>
      <label>
        <span>Tags</span>
        <textarea name="tags" rows="3" placeholder="one tag per line or comma-separated">${escapeHtml((memory.tags ?? []).join("\n"))}</textarea>
      </label>
      <label>
        <span>Evidence</span>
        <textarea name="evidence" rows="3" placeholder="one evidence item per line">${escapeHtml((memory.evidence ?? []).join("\n"))}</textarea>
      </label>
    </form>
  `;
}

function renderSelectOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderMemoryReviewItem(memory) {
  return `
    <article class="review-item">
      <strong>${escapeHtml(memory.title)}</strong>
      <span>${escapeHtml(formatMemoryScope(memory))} · ${formatConfidence(memory.confidence)}</span>
      <p>${escapeHtml(memory.summary)}</p>
      ${renderMemoryProposalReview(memory, { compact: true })}
      <div class="card-actions">
        <button type="button" class="ghost-button" data-action="update-memory-status" data-memory-id="${memory.id}" data-memory-status="accepted">Accept</button>
        <button type="button" class="ghost-button danger-button" data-action="update-memory-status" data-memory-id="${memory.id}" data-memory-status="rejected">Reject</button>
      </div>
    </article>
  `;
}

function normalizeMemoryStatus(status) {
  return ["proposed", "accepted", "rejected", "archived"].includes(status) ? status : "accepted";
}

function filterMemoriesForView(memories) {
  if (state.memoryFilter === "all") return memories;
  return memories.filter((memory) => normalizeMemoryStatus(memory.status) === state.memoryFilter);
}

function memoryScopeOf(memory) {
  return ["global", "group", "user", "thread", "run"].includes(memory.scope) ? memory.scope : "global";
}

function memoryScopeTitle(scope) {
  return {
    global: "Reusable operational lessons",
    group: "Shared group context",
    user: "Personal context",
    thread: "Thread facts",
    run: "Run-local observations",
  }[scope] ?? "Memory";
}

function formatMemoryScope(memory) {
  const scope = memoryScopeOf(memory);
  return memory.scopeId ? `${scope}:${memory.scopeId}` : scope;
}

function memoryRetrievalImpact(memory) {
  const status = normalizeMemoryStatus(memory.status);
  if (status !== "accepted") return "This memory is not injected into agent prompts until accepted.";
  const scope = memoryScopeOf(memory);
  if (scope === "global") return "Accepted global memory can be considered for every matching run.";
  return `Accepted ${scope} memory is injected only when the active run includes exact scope id ${memory.scopeId ?? "(missing)"}.`;
}

function renderMemoryProposalReview(memory, options = {}) {
  if (normalizeMemoryStatus(memory.status) !== "proposed") return "";
  const review = state.memoryReviews.find((candidate) => candidate.memoryId === memory.id);
  if (!review) return "";
  const findingSummary = (review.findings ?? [])
    .map((finding) => `${finding.severity}: ${finding.message}`)
    .join("\n");

  if (options.compact) {
    return `
      <div class="proposal-review compact ${escapeHtml(review.status)}">
        <strong>${escapeHtml(proposalReviewLabel(review.status))}</strong>
        <span>${escapeHtml(review.recommendedAction)}</span>
      </div>
    `;
  }

  return contextBlock(
    "Proposal review",
    `${proposalReviewLabel(review.status)}\n${review.recommendedAction}${findingSummary ? `\n\n${findingSummary}` : ""}`,
  );
}

function proposalReviewLabel(status) {
  if (status === "blocked") return "Blocked before accept";
  if (status === "needs_review") return "Needs operator review";
  return "Ready for review";
}

function renderMemoryPolicySimulation(memory) {
  const decision = memoryPolicyDecision(memory);
  const runLabel = decision.run
    ? `${decision.run.task?.slice(0, 80) || decision.run.id} (${decision.run.id})`
    : "No active run selected; using local default context.";
  return `
    <article class="policy-simulation ${decision.status}">
      <div class="policy-simulation-head">
        <span class="eyebrow">Policy simulation</span>
        <strong>${escapeHtml(formatPolicyDecisionStatus(decision.status))}</strong>
      </div>
      <p>${escapeHtml(decision.summary)}</p>
      <dl>
        <div>
          <dt>Run context</dt>
          <dd>${escapeHtml(runLabel)}</dd>
        </div>
        <div>
          <dt>Requester</dt>
          <dd>${escapeHtml(decision.requesterUserId)}</dd>
        </div>
        <div>
          <dt>Visible scopes</dt>
          <dd>${escapeHtml(decision.visibleScopes.map(formatScopeFilter).join(", "))}</dd>
        </div>
      </dl>
      <ul>${decision.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    </article>
  `;
}

function memoryPolicyDecision(memory) {
  const context = currentMemoryPolicyContext();
  const status = normalizeMemoryStatus(memory.status);
  const scope = memoryScopeOf(memory);
  const sensitivity = memory.sensitivity === "sensitive" || memory.sensitivity === "private" ? memory.sensitivity : "normal";
  const matchedScope = context.visibleScopes.find((candidate) => memoryMatchesScope(memory, candidate));

  if (status !== "accepted") {
    return {
      ...context,
      status: "blocked",
      summary: "This memory will not be injected into a run yet.",
      reasons: [`Memory status is ${status}; only accepted memories can enter retrieval.`],
    };
  }

  if (!matchedScope) {
    return {
      ...context,
      status: "blocked",
      summary: "The selected run cannot see this exact memory scope.",
      reasons: [
        scope === "global"
          ? "The run context does not include global memory visibility."
          : `The run context does not include exact ${scope} scope id ${memory.scopeId ?? "(missing)"}.`,
      ],
    };
  }

  const scopeReason =
    scope === "global"
      ? "Global scope is visible in this run context."
      : `Exact ${scope} scope id ${memory.scopeId ?? "(missing)"} is visible in this run context.`;

  if (sensitivity === "private") {
    if (scope === "user" && memory.scopeId && memory.scopeId === context.requesterUserId) {
      return {
        ...context,
        status: "allowed",
        summary: "This private memory belongs to the requesting user and matches the run context.",
        reasons: [scopeReason, "Private user memory matches the requester user id."],
      };
    }

    return {
      ...context,
      status: "blocked",
      summary: "Private memory is visible by scope but blocked by strict policy simulation.",
      reasons: [
        scopeReason,
        "Private memory requires the same requester user scope or an explicit private-memory policy grant.",
      ],
    };
  }

  if (sensitivity === "sensitive") {
    return {
      ...context,
      status: "needs_review",
      summary: "This memory matches the run context, but sensitive data should require an explicit policy grant.",
      reasons: [scopeReason, "Sensitive memory requires operator policy before broad retrieval."],
    };
  }

  return {
    ...context,
    status: "allowed",
    summary: "This accepted memory can be retrieved by the selected run context.",
    reasons: [scopeReason, "Normal accepted memory passes strict simulation."],
  };
}

function currentMemoryPolicyContext() {
  const run = activeRun();
  const threadId = run?.threadId ?? state.activeThreadId;
  const requesterUserId = run?.requesterUserId ?? state.users?.[0]?.id ?? "user-admin";
  const groupId = run?.instanceId ?? state.instance?.id ?? "group-local";
  return {
    run,
    requesterUserId,
    visibleScopes: dedupeScopeFilters([
      { scope: "global" },
      { scope: "group", scopeId: groupId },
      { scope: "group", scopeId: "group-local" },
      { scope: "user", scopeId: requesterUserId },
      ...(threadId ? [{ scope: "thread", scopeId: threadId }] : []),
      ...(run?.id ? [{ scope: "run", scopeId: run.id }] : []),
    ]),
  };
}

function dedupeScopeFilters(scopes) {
  const seen = new Set();
  return scopes.filter((scope) => {
    const key = `${scope.scope}:${scope.scopeId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function memoryMatchesScope(memory, candidate) {
  const scope = memoryScopeOf(memory);
  if (candidate.scope !== scope) return false;
  if (scope === "global") return true;
  return Boolean(candidate.scopeId) && candidate.scopeId === memory.scopeId;
}

function formatScopeFilter(scope) {
  return scope.scopeId ? `${scope.scope}:${scope.scopeId}` : scope.scope;
}

function formatPolicyDecisionStatus(status) {
  return {
    allowed: "Allowed",
    blocked: "Blocked",
    needs_review: "Needs review",
  }[status] ?? "Unknown";
}

function formatConfidence(confidence) {
  const value = Number.isFinite(Number(confidence)) ? Number(confidence) : 0.75;
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% confidence`;
}

function renderArtifactsPage() {
  const artifacts = state.runs.flatMap((run) => run.result?.artifacts ?? []);
  return `
    <section class="page-stack">
      ${renderFilterBar("Search artifacts...", ["Type", "Owner", "Date"])}
      <div class="artifact-grid large">
        ${artifacts.length
          ? artifacts.map(renderArtifactCard).join("")
          : renderEmptyState("No artifacts", "Generated files will appear here.", "Artifacts")}
      </div>
    </section>
  `;
}

function renderToolsPage() {
  const visibleTools = filterToolsForView(state.tools);
  const selected =
    visibleTools.find((tool) => tool.name === state.selectedToolName) ??
    state.tools.find((tool) => tool.name === state.selectedToolName) ??
    visibleTools[0] ??
    state.tools[0];
  return `
    <section class="tools-layout">
      <section class="page-stack">
        <section class="surface-hero">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Tool registry</span>
              <h2>Installed capabilities</h2>
              <p>Built-in and generated TypeScript tools live here. Healthchecks update persistent registry metadata and surface failed tools for rework.</p>
            </div>
            <button type="button" class="primary-button" data-action="run-tool-health">Run Healthchecks</button>
          </div>
        </section>
        <section class="filter-bar">
          <input data-action="search-tools" value="${escapeHtml(state.toolSearch ?? "")}" placeholder="Search tools by name, system id, description, tags, version, or schema..." />
          <button type="button">Status</button>
          <button type="button">Source</button>
          <button type="button">Capability</button>
        </section>
        <div class="card-grid">
          ${visibleTools.length
            ? visibleTools.map(renderToolCard).join("")
            : renderEmptyState(
                state.tools.length ? "No matching tools" : "No tools",
                state.tools.length ? "Try another name, system id, tag, or description." : "Register your first tool.",
                "Tools",
              )}
        </div>
      </section>
      <aside class="surface-panel inspector-panel">
        ${selected ? renderToolDetail(selected) : renderEmptyState("No tool selected", "Registered tools will appear here.", "Tools")}
      </aside>
    </section>
  `;
}

function filterToolsForView(tools) {
  const query = String(state.toolSearch ?? "").trim().toLowerCase();
  if (!query) return tools;
  return tools.filter((tool) => toolMatchesSearch(tool, query));
}

function toolMatchesSearch(tool, query) {
  const haystack = [
    tool.displayName,
    tool.name,
    tool.version,
    tool.description,
    tool.source,
    tool.status,
    tool.startupMode,
    ...(tool.capabilities ?? []),
    ...(tool.requiredConfigurationKeys ?? []),
    ...(tool.requiredSecretHandles ?? []),
    tool.docsMarkdown,
    JSON.stringify(tool.inputSchema ?? {}),
    JSON.stringify(tool.outputSchema ?? {}),
    ...(tool.examples ?? []).flatMap((example) => [
      example.title,
      example.description,
      JSON.stringify(example.input ?? {}),
    ]),
    ...(tool.versions ?? []).flatMap((version) => [
      version.version,
      version.status,
      version.active ? "active" : "",
      version.lastHealthDetail,
    ]),
  ];
  return haystack.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function renderToolCard(tool) {
  const label = tool.displayName || tool.name;
  const isGenerated = tool.source === "generated";
  const service = serviceForTool(tool.name);
  return `
    <article class="tool-card ${state.selectedToolName === tool.name ? "selected" : ""}" data-action="select-tool" data-tool-name="${tool.name}" tabindex="0">
      <div class="card-topline">
        <span>${tool.source ?? "builtin"}</span>
        <span>${tool.status ?? "available"}</span>
      </div>
      <h3>${escapeHtml(label)} <small>v${escapeHtml(tool.version)}</small></h3>
      <small class="status-note">System name: ${escapeHtml(tool.name)}</small>
      ${service ? `<small class="status-note">Service: ${escapeHtml(service.status)} · ${escapeHtml(service.desiredState)}</small>` : ""}
      <p>${escapeHtml(tool.description)}</p>
      <div class="tag-row">${(tool.capabilities ?? []).slice(0, 5).map((capability) => `<span>${escapeHtml(capability)}</span>`).join("")}</div>
      <div class="card-actions">
        <button type="button" class="ghost-button" data-action="select-tool" data-tool-name="${tool.name}">Inspect</button>
        ${isGenerated ? `<button type="button" class="ghost-button danger-button" data-action="delete-tool" data-tool-name="${tool.name}">Delete</button>` : ""}
      </div>
    </article>
  `;
}

function renderToolDetail(tool) {
  const failureProblem = toolFailureProblem(tool);
  const label = tool.displayName || tool.name;
  const service = serviceForTool(tool.name);
  return `
    <div class="inspector-stack">
      <span class="eyebrow">Tool detail</span>
      <h2>${escapeHtml(label)}</h2>
      <div class="inspector-meta">
        <span>${escapeHtml(tool.source ?? "builtin")}</span>
        <span>${escapeHtml(tool.status ?? "available")}</span>
        <span>v${escapeHtml(tool.version ?? "n/a")}</span>
        ${tool.lastHealthOk === undefined ? "" : `<span>${tool.lastHealthOk ? "healthy" : "unhealthy"}</span>`}
      </div>
      ${contextBlock("System name", tool.name)}
      ${contextBlock("Purpose", tool.description || "No description.")}
      ${contextBlock("Capabilities", (tool.capabilities ?? []).join("\n") || "No capabilities.")}
      ${contextBlock("Startup mode", tool.startupMode ?? "default")}
      ${service ? renderToolServiceControls(service) : ""}
      ${contextBlock("Health", formatToolHealth(tool))}
      ${contextBlock("Settings", formatToolSettings(tool))}
      ${contextBlock("Storage", formatToolStorage(tool))}
      ${contextBlock("Migrations", formatToolMigrations(tool))}
      ${contextBlock("Telemetry", formatToolTelemetry(tool))}
      ${contextBlock("Examples", formatToolExamples(tool))}
      ${contextBlock("Schema", formatToolSchemas(tool))}
      ${renderToolVersionPicker(tool)}
      ${renderToolVersionHistory(tool)}
      ${renderToolReworkForm(tool, failureProblem)}
      ${tool.source === "generated" ? `<button type="button" class="ghost-button danger-button" data-action="delete-tool" data-tool-name="${tool.name}">Delete generated tool</button>` : ""}
    </div>
  `;
}

function serviceForTool(toolName) {
  return state.toolServices.find((service) => service.toolName === toolName);
}

function renderToolServiceControls(service) {
  return `
    <section class="context-block service-control-block">
      <h4>Service lifecycle</h4>
      <div class="service-status-row">
        <span class="status-pill ${escapeHtml(service.status)}">${escapeHtml(service.status)}</span>
        <span>${escapeHtml(service.desiredState)}</span>
        <span>${escapeHtml(service.lastHeartbeatAt ? formatRelative(service.lastHeartbeatAt) : "no heartbeat")}</span>
      </div>
      <p>${escapeHtml(service.detail || "No service detail.")}</p>
      <div class="action-row compact">
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="start">Start</button>
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="restart">Restart</button>
        <button type="button" class="ghost-button danger-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="stop">Stop</button>
      </div>
    </section>
  `;
}

function renderToolVersionPicker(tool) {
  if (tool.source !== "generated") return "";
  const versions = normalizeToolVersions(tool);
  return `
    <section class="context-block">
      <h4>Active version</h4>
      <form data-action="activate-tool-version" class="inline-form">
        <input type="hidden" name="toolName" value="${escapeHtml(tool.name)}" />
        <select name="version" aria-label="Active tool version">
          ${versions
            .map(
              (version) => `
                <option value="${escapeHtml(version.version)}" ${version.active ? "selected" : ""}>
                  v${escapeHtml(version.version)}${version.active ? " · active" : ""}${version.status ? ` · ${escapeHtml(version.status)}` : ""}
                </option>
              `,
            )
            .join("")}
        </select>
        <button type="submit" class="ghost-button">Activate</button>
      </form>
      <p class="context-note">Change requests create a new version; the highest generated version is promoted by default after QA.</p>
    </section>
  `;
}

function renderToolVersionHistory(tool) {
  if (tool.source !== "generated") return "";
  const versions = normalizeToolVersions(tool);
  return `
    <section class="context-block version-history-block">
      <h4>Version history</h4>
      <div class="version-history-list">
        ${versions
          .map((version) => {
            const telemetry = [
              `${version.successCount ?? 0} ok`,
              `${version.failureCount ?? 0} failed`,
              version.requiredSecretHandles?.length ? `secrets: ${version.requiredSecretHandles.join(", ")}` : "no secrets",
            ].join(" · ");
            return `
              <article class="version-history-card ${version.active ? "active" : ""}">
                <div class="version-history-header">
                  <strong>v${escapeHtml(version.version)}</strong>
                  <span>${version.active ? "active" : escapeHtml(version.status ?? "available")}</span>
                </div>
                <p>${escapeHtml(version.changeSummary || version.description || "No changelog recorded for this version.")}</p>
                <small>${escapeHtml(telemetry)}</small>
                <small>${escapeHtml(version.modulePath || "No module path")}${version.testPath ? ` · ${escapeHtml(version.testPath)}` : ""}</small>
                ${version.lastHealthDetail ? `<small>${escapeHtml(version.lastHealthDetail)}</small>` : ""}
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function normalizeToolVersions(tool) {
  const versions = Array.isArray(tool.versions) && tool.versions.length
    ? tool.versions
    : [{ version: tool.version ?? "1.0.0", active: true, status: tool.status }];
  return [...versions].sort(compareToolVersionsDesc);
}

function compareToolVersionsDesc(a, b) {
  const left = String(a.version ?? "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b.version ?? "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function formatToolSettings(tool) {
  const config = tool.requiredConfigurationKeys ?? [];
  const secrets = tool.requiredSecretHandles ?? [];
  return [
    config.length ? `Configuration keys:\n${config.map((item) => `- ${item}`).join("\n")}` : "No required configuration keys.",
    secrets.length ? `Secret handles:\n${secrets.map((item) => `- ${item}`).join("\n")}` : "No required secret handles.",
  ].join("\n\n");
}

function formatToolStorage(tool) {
  const storage = tool.storage;
  if (!storage) return "No tool-owned storage declared.";
  return [
    storage.schema ? `Schema: ${storage.schema}` : undefined,
    storage.tables?.length ? `Tables: ${storage.tables.join(", ")}` : undefined,
    storage.migrations?.length ? `Migrations: ${storage.migrations.join(", ")}` : undefined,
    storage.permissions?.length ? `DB permissions: ${storage.permissions.join(", ")}` : undefined,
    storage.retention ? `Retention: ${storage.retention}` : undefined,
    storage.destructiveCapabilities?.length
      ? `Destructive capabilities: ${storage.destructiveCapabilities.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n") || "Storage contract is empty.";
}

function formatToolMigrations(tool) {
  const migrations = (state.toolMigrations ?? [])
    .filter((migration) => migration.toolName === tool.name)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  if (!migrations.length) {
    const declared = tool.storage?.migrations ?? [];
    return declared.length
      ? `Declared, not applied yet:\n${declared.map((migration) => `- ${migration}`).join("\n")}`
      : "No migration records.";
  }
  return migrations
    .slice(0, 5)
    .map((migration) => {
      const status = migration.status ?? "pending";
      const applied = migration.appliedAt ? ` · applied ${formatRelative(migration.appliedAt)}` : "";
      return `${migration.migrationId} · ${migration.toolVersion} · ${status}${applied}`;
    })
    .join("\n");
}

function formatToolTelemetry(tool) {
  return [
    `Successes: ${tool.successCount ?? 0}`,
    `Failures: ${tool.failureCount ?? 0}`,
    tool.lastSuccessAt ? `Last success: ${formatRelative(tool.lastSuccessAt)}` : undefined,
    tool.lastFailureAt ? `Last failure: ${formatRelative(tool.lastFailureAt)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatToolExamples(tool) {
  const examples = tool.examples ?? [];
  if (!examples.length) return tool.docsMarkdown || "No agent-readable docs or examples yet.";
  return examples
    .slice(0, 3)
    .map((example) => `${example.title}\ninput: ${JSON.stringify(example.input)}`)
    .join("\n\n");
}

function renderToolReworkForm(tool, failureProblem) {
  const isFailed = tool.status === "failed";
  const defaultFeedback = isFailed
    ? failureProblem
    : [
        `Change request for "${tool.displayName || tool.name}".`,
        "Describe the behavior to add or correct. Preserve reusable TypeScript module boundaries, docs, tests, healthchecks, and public contract compatibility where possible.",
      ].join("\n");
  const activeVersion = normalizeToolVersions(tool).find((version) => version.active)?.version ?? tool.version ?? "1.0.0";
  return `
    <details class="rework-box tool-rework-box">
      <summary>Request change / new version</summary>
      <form data-action="rework-tool" class="rework-form">
        <input type="hidden" name="toolName" value="${escapeHtml(tool.name)}" />
        <input type="hidden" name="displayName" value="${escapeHtml(tool.displayName || tool.name)}" />
        <input type="hidden" name="capability" value="${escapeHtml((tool.capabilities ?? [tool.name])[0] ?? tool.name)}" />
        <input type="hidden" name="replacesVersion" value="${escapeHtml(activeVersion)}" />
        <input type="hidden" name="startupMode" value="${escapeHtml(tool.startupMode ?? "on-demand")}" />
        <label>
          <span>Change request</span>
          <textarea name="feedback" required>${escapeHtml(defaultFeedback)}</textarea>
        </label>
        <button type="submit" class="ghost-button">Create versioned change request</button>
      </form>
    </details>
  `;
}

function toolFailureProblem(tool) {
  const health = tool.lastHealthDetail ?? tool.health?.detail ?? tool.healthDetail ?? "";
  return [
    `Existing tool "${tool.name}" is marked failed and needs a rebuilt TypeScript module.`,
    health ? `Observed failure: ${health}` : "Observed failure: status is failed but no detailed health message is available.",
    "Preserve the public tool contract where possible, add regression tests, and only register the replacement after QA passes.",
  ].join("\n");
}

function formatToolSchemas(tool) {
  const input = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : "No input schema.";
  const output = tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : "No output schema.";
  return `Input:\n${input}\n\nOutput:\n${output}`;
}

function formatToolHealth(tool) {
  if (tool.lastHealthOk === undefined) return "Healthcheck has not been run yet.";
  const status = tool.lastHealthOk ? "healthy" : "unhealthy";
  return `${status}: ${tool.lastHealthDetail || "No detail recorded."}`;
}

function renderToolBuildsPage() {
  const columns = ["requested", "building", "qa_failed", "qa_passed", "registered", "blocked"];
  const defaultQaCriteria = [
    "The generated tool must be TypeScript, reusable outside this specific request, documented, and registered only after QA passes.",
    "Validate input/output schemas and reject unsafe or incomplete inputs with structured failures.",
    "Add focused automated tests for success, invalid input, and provider/tool failure paths.",
    "Run a manual smoke check that proves the tool can satisfy the requested capability.",
    "Do not leak credentials into prompts, logs, generated source, tests, traces, memory, or artifacts.",
  ].join("\n");
  return `
    <section class="page-stack">
      <section class="surface-hero">
        <span class="eyebrow">Self-service capability queue</span>
        <h2>Tool Builds</h2>
        <p>Requested means a real build request exists in the durable queue. The background Tool Builder worker claims waiting requests automatically; the manual run button stays available as an operator fallback. Nothing in these columns is placeholder data; empty columns show “No requests”.</p>
        <div class="status-guide">
          ${columns.map((column) => `<span><strong>${formatStatusLabel(column)}</strong>${escapeHtml(toolBuildStatusDescription(column))}</span>`).join("")}
        </div>
      </section>
      <details class="surface-panel tool-build-request-panel expandable-panel">
        <summary>
          <div>
            <span class="eyebrow">Builder + QA + registry</span>
            <h2>Request a Tool</h2>
            <p>Describe the tool you need in normal language. The builder will derive the internal system name, schemas, settings, and QA plan.</p>
          </div>
          <span class="context-chip">Open request form</span>
        </summary>
        <form data-action="create-tool-build-request" class="settings-form">
          <label>
            <span>Tool name</span>
            <input name="displayName" placeholder="Tool name" required />
            <small>Human name shown in Tools, traces, and operator screens. The builder generates the internal system name automatically.</small>
          </label>
          <label>
            <span>Description, docs, and expected behavior</span>
            <textarea name="reason" placeholder="Describe what the tool should do, where the documentation is, what inputs it should accept, what result it should return, and how an agent should know when to use it." required></textarea>
          </label>
          <label>
            <span>Run mode</span>
            <select name="startupMode">
              <option value="on-demand">On demand: agent calls it only when needed</option>
              <option value="always-on">Always running: service/listener with health status</option>
              <option value="ephemeral">Ephemeral: short-lived job, then shuts down</option>
            </select>
            <small>Use “always running” for bots, webhooks, queue listeners, or other modules that should stay alive and report health.</small>
          </label>
          <label>
            <span>Credentials</span>
            <textarea name="credentialNotes" rows="3" placeholder="Paste credentials or references only if this tool needs access. Example: API key, bot token, client id/secret. The builder will infer how to store and use them."></textarea>
            <small>The builder treats this as sensitive setup context and must not leak it into generated code, traces, tests, memory, or artifacts.</small>
          </label>
          <label>
            <span>QA criteria</span>
            <textarea name="qaCriteria" rows="5">${escapeHtml(defaultQaCriteria)}</textarea>
            <small>You can add extra acceptance checks here before creating the request.</small>
          </label>
          <div class="composer-bottom">
            <p class="composer-hint">Created tools must be TypeScript modules with docs, tests, healthchecks, and registry metadata.</p>
            <button type="submit" class="primary-button">Create Build Request</button>
          </div>
        </form>
      </details>
      <section class="kanban-board">
        ${columns
          .map(
            (column) => `
              <section class="kanban-column">
                <div class="kanban-heading">
                  <h2>${formatStatusLabel(column)}</h2>
                  <span>${state.buildRequests.filter((request) => request.status === column).length}</span>
                </div>
                <p class="kanban-column-note">${escapeHtml(toolBuildStatusDescription(column))}</p>
                ${state.buildRequests.filter((request) => request.status === column).map(renderBuildCard).join("") || `<p class="muted">No requests</p>`}
              </section>
            `,
          )
          .join("")}
      </section>
    </section>
  `;
}

function renderBuildCard(request) {
  return `
    <article class="build-card">
      <div class="card-topline">
        <span>${escapeHtml(formatStatusLabel(request.status))}</span>
        <span>${formatRelative(request.updatedAt ?? request.createdAt)}</span>
      </div>
      <strong>${escapeHtml(request.displayName || request.capability)}</strong>
      <small class="status-note">System capability: ${escapeHtml(request.capability)}</small>
      <small class="status-note">Run mode: ${escapeHtml(request.contract?.startupMode ?? "on-demand")}</small>
      <small class="status-note">${escapeHtml(toolBuildCardComment(request))}</small>
      <p>${escapeHtml(request.reason)}</p>
      <small>${escapeHtml(request.contract?.toolName ?? "tool contract pending")}</small>
      <small>${escapeHtml(request.contract?.modulePath ?? "module pending")}</small>
      ${(request.credentialHandles ?? []).length ? `<small class="status-note">Credentials: ${request.credentialHandles.map((handle) => `<code>${escapeHtml(handle)}</code>`).join(" ")}</small>` : ""}
      ${request.credentialNotes ? `<small class="status-note">Credentials: provided by operator</small>` : ""}
      ${request.feedback ? `<small class="status-note">Latest feedback: ${escapeHtml(request.feedback)}</small>` : ""}
      ${request.statusDetail ? `<small class="status-note">Status detail: ${escapeHtml(request.statusDetail)}</small>` : ""}
      ${request.qaReport ? `<small class="status-note">QA: ${escapeHtml(request.qaReport.summary)}</small>` : ""}
      <details class="build-preview">
        <summary>Preview</summary>
        ${contextBlock("Tool contract", `${request.contract?.toolName ?? "pending"}\n${request.contract?.modulePath ?? "module pending"}\n${request.contract?.testPath ?? "test pending"}`)}
        ${contextBlock("Run mode", request.contract?.startupMode ?? "on-demand")}
        ${contextBlock("QA criteria", (request.contract?.qaCriteria ?? request.qaCriteria ?? []).join("\n") || "No QA criteria.")}
      </details>
      <div class="card-actions">
        ${["requested", "qa_failed", "blocked"].includes(request.status)
          ? `<button type="button" class="ghost-button" data-action="run-tool-build" data-build-id="${request.id}">Run builder</button>`
          : ""}
        <button type="button" class="ghost-button" data-action="stop-tool-build" data-build-id="${request.id}">Stop</button>
        <button type="button" class="ghost-button danger-button" data-action="delete-tool-build" data-build-id="${request.id}">Delete</button>
      </div>
      <details class="rework-box">
        <summary>Create revision request</summary>
        <form data-action="rework-tool-build" class="rework-form">
          <input type="hidden" name="buildId" value="${escapeHtml(request.id)}" />
          <textarea name="feedback" placeholder="What should be changed, fixed, retested, or redesigned?" required></textarea>
          <button type="submit" class="ghost-button">Create rework request</button>
        </form>
      </details>
    </article>
  `;
}

function formatStatusLabel(status) {
  return String(status).replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toolBuildStatusDescription(status) {
  return {
    requested: "Real request waiting to be claimed by the background builder or a manual run.",
    building: "Builder is generating or revising TypeScript source and tests.",
    qa_failed: "Build ran, but tests or QA rejected it; feedback should drive a revision.",
    qa_passed: "QA passed; the module is ready for registration/promotion.",
    registered: "Tool metadata is registered and can be loaded by the runtime.",
    blocked: "The request needs missing docs, credentials, provider support, or a human decision.",
  }[status] ?? "Unknown lifecycle state.";
}

function toolBuildCardComment(request) {
  if (request.status === "requested") {
    return "This card is here because no builder has successfully claimed and completed it yet.";
  }
  if (request.status === "building") {
    return "This card is here because a builder run is in progress or last marked the request as building.";
  }
  if (request.status === "qa_failed") {
    return "This card is here because generated output did not satisfy QA criteria.";
  }
  if (request.status === "qa_passed") {
    return "This card is here because QA passed but registration has not completed yet.";
  }
  if (request.status === "registered") {
    return "This card is here because the generated capability was promoted into the tool registry.";
  }
  if (request.status === "blocked") {
    return "This card is here because the workflow cannot proceed without more input or support.";
  }
  return "Lifecycle status explanation is unavailable.";
}

function renderModelsPage() {
  const chatModels = state.modelCatalog?.chat?.models ?? [];
  const embeddingModels = state.modelCatalog?.embedding?.models ?? [];
  const providers = state.modelProviders.length ? state.modelProviders : state.modelCatalog?.providers ?? [];
  return `
    <section class="page-stack">
      <section class="surface-panel model-catalog-panel">
        <div class="section-heading">
          <div>
            <h2>Model Catalog</h2>
            <p>Discovered local OpenAI-compatible models and the active embedding provider. Remote providers are added as secret-backed model configs, then assigned to tiers.</p>
          </div>
          <span class="context-chip">${chatModels.length} chat · ${embeddingModels.length} embedding candidates</span>
        </div>
        <div class="model-catalog-grid">
          <article class="tool-card">
            <div class="card-topline"><span>Chat endpoint</span><span>${escapeHtml(state.modelCatalog?.chat?.baseUrl ?? "not loaded")}</span></div>
            <h3>Local chat models</h3>
            <div class="model-pill-list">
              ${chatModels.length
                ? chatModels.map((model) => `<span class="model-pill">${escapeHtml(model.id)}</span>`).join("")
                : `<span class="muted">No /models response yet. Check the local server or add model ids manually below.</span>`}
            </div>
          </article>
          <article class="tool-card">
            <div class="card-topline"><span>Embedding</span><span>${escapeHtml(state.modelCatalog?.embedding?.provider ?? "deterministic")}</span></div>
            <h3>${escapeHtml(state.modelCatalog?.embedding?.model ?? "Deterministic fallback")}</h3>
            <p class="muted">Dimensions: ${escapeHtml(String(state.modelCatalog?.embedding?.dimensions ?? 128))}. For semantic memory, configure an embedding model separately from chat tiers.</p>
            <div class="model-pill-list">
              ${embeddingModels.length
                ? embeddingModels.map((model) => `<span class="model-pill">${escapeHtml(model.id)}</span>`).join("")
                : `<span class="muted">No embedding model catalog available from the configured endpoint.</span>`}
            </div>
          </article>
        </div>
      </section>
      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Provider Registry</h2>
            <p>Register local and remote OpenAI-compatible providers. Store secret handles here, not raw API keys; chat tiers reference model ids, while memory uses an embedding provider.</p>
          </div>
          <span class="context-chip">${providers.length} providers</span>
        </div>
        <div class="model-provider-grid">
          ${providers.map(renderModelProviderCard).join("") || renderEmptyState("No model providers", "Add a local, remote, or embedding provider.", "Providers")}
        </div>
      </section>
      <form data-action="create-model-provider" class="surface-panel settings-form">
        <div class="section-heading">
          <div>
            <h2>Add Provider</h2>
            <p>Use this for local LM Studio/Ollama-compatible endpoints, OpenAI-compatible remote APIs, or a dedicated embedding model for memory.</p>
          </div>
          <button type="submit" class="primary-button">Add Provider</button>
        </div>
        <div class="settings-grid">
          <label>
            <span>Label</span>
            <input name="label" placeholder="OpenAI GPT-5.2" required />
          </label>
          <label>
            <span>Kind</span>
            <select name="kind">
              <option value="chat">Chat</option>
              <option value="embedding">Embedding</option>
            </select>
          </label>
          <label>
            <span>Provider type</span>
            <select name="providerType">
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="deterministic">Deterministic</option>
            </select>
          </label>
          <label>
            <span>Base URL</span>
            <input name="baseUrl" placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            <span>Model ids</span>
            <textarea name="modelIds" rows="3" placeholder="gpt-5.2&#10;text-embedding-3-large"></textarea>
          </label>
          <label>
            <span>Default model</span>
            <input name="defaultModel" placeholder="gpt-5.2" />
          </label>
          <label>
            <span>Secret handle</span>
            <input name="apiKeySecretHandle" placeholder="openai-prod-api-key" />
          </label>
          <label>
            <span>Embedding dimensions</span>
            <input name="dimensions" type="number" min="1" max="8192" placeholder="1536" />
          </label>
        </div>
      </form>
      <form data-action="save-model-tiers" class="surface-panel settings-form">
        <div class="section-heading">
          <div>
            <h2>Model Tier Policy</h2>
            <p>Add local or OpenAI-compatible remote chat models. The runtime uses fallback order per tier; embeddings are configured separately for memory retrieval.</p>
          </div>
          <button type="submit" class="primary-button">Save Models</button>
        </div>
        <div class="tier-editor-grid">
          ${state.tiers.map(renderTierCard).join("") || renderEmptyState("No model tiers", "Configure S/M/L/XL routing.", "Models")}
        </div>
      </form>
    </section>
  `;
}

function renderModelProviderCard(provider) {
  const models = provider.modelIds ?? [];
  return `
    <article class="tool-card">
      <div class="card-topline">
        <span>${escapeHtml(provider.kind)} · ${escapeHtml(provider.providerType)}</span>
        <span>${escapeHtml(provider.status ?? "available")}</span>
      </div>
      <h3>${escapeHtml(provider.label)}</h3>
      <p class="muted">${escapeHtml(provider.baseUrl ?? "No network endpoint required")}</p>
      <div class="model-pill-list">
        ${models.length
          ? models.map((model) => `<span class="model-pill">${escapeHtml(model)}</span>`).join("")
          : `<span class="muted">${provider.kind === "embedding" ? "Deterministic or not configured" : "No model ids yet"}</span>`}
      </div>
      <dl class="compact-meta">
        <div><dt>Default</dt><dd>${escapeHtml(provider.defaultModel ?? "not set")}</dd></div>
        <div><dt>Secret</dt><dd>${escapeHtml(provider.apiKeySecretHandle ?? "none")}</dd></div>
        <div><dt>Health</dt><dd>${escapeHtml(provider.healthStatus ?? "unknown")}</dd></div>
        ${provider.dimensions ? `<div><dt>Dimensions</dt><dd>${escapeHtml(String(provider.dimensions))}</dd></div>` : ""}
      </dl>
      <div class="card-actions">
        <button type="button" class="ghost-button" data-action="delete-model-provider" data-provider-id="${escapeHtml(provider.id)}">Delete</button>
      </div>
    </article>
  `;
}

function renderTierCard(tier) {
  return `
    <article class="tool-card tier-editor-card">
      <div class="card-topline"><span>Tier ${tier.tier}</span><span>${tier.escalateOnFailure ? "Escalates" : "Pinned"}</span></div>
      <h3>${tierLabel(tier.tier)}</h3>
      <input type="hidden" name="tier" value="${escapeHtml(tier.tier)}" />
      <label>
        <span>Models, fallback order</span>
        <textarea name="models-${tier.tier}" rows="4">${escapeHtml((tier.models ?? []).join("\n"))}</textarea>
      </label>
      <label>
        <span>Max attempts</span>
        <input name="maxAttempts-${tier.tier}" type="number" min="1" max="5" value="${tier.maxAttempts ?? 2}" />
      </label>
      <label class="inline-check">
        <input name="escalateOnFailure-${tier.tier}" type="checkbox" ${tier.escalateOnFailure ? "checked" : ""} />
        <span>Escalate after failed fallback attempts</span>
      </label>
    </article>
  `;
}

function renderGroupProfilePage() {
  const profile = state.groupProfile ?? {};
  const notes = typeof profile.preferences?.notes === "string" ? profile.preferences.notes : "";
  return `
    <section class="page-stack">
      <form data-action="save-group-profile" class="surface-panel settings-form">
        <div class="section-heading">
          <div>
            <h2>Group Profile</h2>
            <p>One instance serves one family, company, or team. This context is included in future agent work.</p>
          </div>
          <button type="submit" class="primary-button">Save Group Context</button>
        </div>
        <label>
          <span>Group name</span>
          <input name="name" value="${escapeHtml(profile.name ?? "Local Group Profile")}" />
        </label>
        <label>
          <span>Who this assistant serves</span>
          <textarea name="description" placeholder="Describe the group, goals, constraints, languages, location, business/family needs.">${escapeHtml(profile.description ?? "")}</textarea>
        </label>
        <label>
          <span>Shared rules and preferences</span>
          <textarea name="preferencesNotes" placeholder="Preferred tone, decision rules, travel constraints, tools that need approval, recurring habits.">${escapeHtml(notes)}</textarea>
        </label>
      </form>
    </section>
  `;
}

function renderUsersPage() {
  return `
    <section class="page-stack">
      <form data-action="create-user" class="surface-panel settings-form">
        <div class="section-heading">
          <div>
            <h2>Users & Channel Identities</h2>
            <p>Manage the one-instance member list and whitelist external channel identities.</p>
          </div>
          <button type="submit" class="primary-button">Create User</button>
        </div>
        <div class="form-grid three">
          <label>
            <span>Display name</span>
            <input name="displayName" placeholder="Dimitrii" required />
          </label>
          <label>
            <span>Primary role</span>
            <input name="role" placeholder="member" value="member" />
          </label>
          <label>
            <span>Roles</span>
            <input name="roles" placeholder="member, admin, viewer" value="member" />
          </label>
        </div>
      </form>
      ${renderFilterBar("Search users...", ["Role", "Status", "Identity"])}
      <div class="card-grid">
        ${state.users.length
          ? state.users.map(renderUserCard).join("")
          : renderEmptyState("No users", "The local admin user should appear here after refresh.", "Users")}
      </div>
    </section>
  `;
}

function renderUserCard(user) {
  return `
    <article class="knowledge-card">
      <div class="card-topline"><span>${escapeHtml(user.role)}</span><span>${escapeHtml(user.status)}</span></div>
      <h3>${escapeHtml(user.displayName)}</h3>
      <p>${escapeHtml(user.id)}</p>
      <form data-action="update-user" class="inline-edit-form">
        <input type="hidden" name="userId" value="${escapeHtml(user.id)}" />
        <label>
          <span>Name</span>
          <input name="displayName" value="${escapeHtml(user.displayName)}" />
        </label>
        <label>
          <span>Roles</span>
          <input name="roles" value="${escapeHtml((user.roles ?? [user.role]).join(", "))}" />
        </label>
        <div class="action-row">
          <button type="submit" class="ghost-button">Save user</button>
          ${user.id === "user-admin" ? "" : `<button type="button" class="danger-button" data-action="delete-user" data-user-id="${escapeHtml(user.id)}">Delete</button>`}
        </div>
      </form>
      <div class="identity-list">
        ${(user.identities ?? []).map(renderChannelIdentityRow).join("") || "<small>No channel identities yet.</small>"}
      </div>
      <form data-action="create-channel-identity" class="inline-edit-form">
        <input type="hidden" name="userId" value="${escapeHtml(user.id)}" />
        <div class="form-grid two">
          <label>
            <span>Provider</span>
            <input name="provider" placeholder="telegram" />
          </label>
          <label>
            <span>Provider user id</span>
            <input name="providerUserId" placeholder="123456789" />
          </label>
        </div>
        <label>
          <span>Allow status</span>
          <select name="allowStatus">
            <option value="allowed">allowed</option>
            <option value="blocked">blocked</option>
          </select>
        </label>
        <button type="submit" class="ghost-button">Add identity</button>
      </form>
      <small>${user.recentRequests?.length ?? 0} recent requests</small>
    </article>
  `;
}

function renderChannelIdentityRow(identity) {
  const nextStatus = identity.allowStatus === "allowed" ? "blocked" : "allowed";
  return `
    <div class="identity-row">
      <div>
        <strong>${escapeHtml(identity.provider)}:${escapeHtml(identity.providerUserId)}</strong>
        <small>${escapeHtml(identity.id)} · ${escapeHtml(identity.allowStatus)}</small>
      </div>
      <div class="action-row compact">
        <button type="button" class="ghost-button" data-action="toggle-channel-identity" data-identity-id="${escapeHtml(identity.id)}" data-allow-status="${nextStatus}">
          ${nextStatus === "allowed" ? "Allow" : "Block"}
        </button>
        <button type="button" class="danger-button" data-action="delete-channel-identity" data-identity-id="${escapeHtml(identity.id)}">Delete</button>
      </div>
    </div>
  `;
}

function renderChannelsPage() {
  const services = [...state.toolServices].sort((a, b) => a.toolName.localeCompare(b.toolName));
  const running = services.filter((service) => service.status === "running").length;
  const failed = services.filter((service) => service.status === "failed").length;
  return `
    <section class="page-stack">
      <section class="surface-hero">
        <span class="eyebrow">Always-on runtime</span>
        <h2>Channels</h2>
        <p>External intake is modeled as generated always-on tools: bots, webhooks, queue listeners, and outbound senders. This page monitors lifecycle state without hardcoding Telegram or any provider into the core.</p>
        <div class="metric-card-grid">
          ${metricCard("Services", String(services.length), "startupMode=always-on")}
          ${metricCard("Running", String(running), "healthy heartbeat")}
          ${metricCard("Failed", String(failed), "needs rework or credentials")}
        </div>
      </section>
      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Service Tools</h2>
            <p>Start, stop, restart, and heartbeat-check installed always-on modules. New bots/listeners are created from Tool Builds.</p>
          </div>
          <button type="button" class="ghost-button" data-action="navigate" data-route="tool-builds">Create always-on tool</button>
        </div>
        <div class="service-grid">
          ${services.length ? services.map(renderServiceCard).join("") : renderEmptyState("No always-on tools", "Create a Tool Build request and choose Run mode: Always running.", "Tool Builds")}
        </div>
      </section>
      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Runtime Events</h2>
            <p>Provider-neutral inbound, outbound, and system events written by always-on tools.</p>
          </div>
          <span class="context-chip">${state.toolServiceEvents.length} recent</span>
        </div>
        <div class="service-event-list">
          ${state.toolServiceEvents.length ? state.toolServiceEvents.slice(0, 12).map(renderServiceEventRow).join("") : renderEmptyState("No service events", "Bots, webhooks, and listeners will record inbound/outbound events here.", "Events")}
        </div>
      </section>
    </section>
  `;
}

function renderServiceCard(service) {
  return `
    <article class="tool-card service-card">
      <div class="card-topline">
        <span>${escapeHtml(service.status)}</span>
        <span>${escapeHtml(service.desiredState)}</span>
      </div>
      <h3>${escapeHtml(service.displayName || service.toolName)}</h3>
      <small class="status-note">${escapeHtml(service.toolName)}</small>
      <p>${escapeHtml(service.description || "No description.")}</p>
      <div class="service-status-row">
        <span class="status-pill ${escapeHtml(service.status)}">${escapeHtml(service.status)}</span>
        <span>${escapeHtml(service.lastHeartbeatAt ? `heartbeat ${formatRelative(service.lastHeartbeatAt)}` : "no heartbeat")}</span>
        <span>${escapeHtml(`${service.restartCount ?? 0} restarts`)}</span>
      </div>
      <small class="status-note">${escapeHtml(service.detail || "No service detail.")}</small>
      ${renderServiceLogPreview(service.toolName)}
      <div class="card-actions">
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="start">Start</button>
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="restart">Restart</button>
        <button type="button" class="ghost-button danger-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="stop">Stop</button>
      </div>
    </article>
  `;
}

function renderServiceLogPreview(toolName) {
  const logs = state.toolServiceLogs
    .filter((log) => log.toolName === toolName)
    .slice(0, 4);
  if (!logs.length) {
    return `<div class="service-log-preview muted">No lifecycle logs yet.</div>`;
  }
  return `
    <div class="service-log-preview">
      ${logs.map((log) => `
        <div class="service-log-line ${escapeHtml(log.level)}">
          <span>${escapeHtml(formatRelative(log.createdAt))}</span>
          <strong>${escapeHtml(log.message)}</strong>
          <small>${escapeHtml(log.detail || log.status || "")}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function renderServiceEventRow(event) {
  const source = [event.sourceUserId, event.sourceChatId, event.sourceMessageId].filter(Boolean).join(" / ");
  return `
    <article class="service-event-row">
      <div>
        <div class="event-row-title">
          <span class="status-pill ${escapeHtml(event.status)}">${escapeHtml(event.status)}</span>
          <strong>${escapeHtml(event.summary)}</strong>
        </div>
        <small>${escapeHtml(event.toolName)} · ${escapeHtml(event.direction)}${source ? ` · ${escapeHtml(source)}` : ""}</small>
      </div>
      <div class="service-event-links">
        ${event.threadId ? `<button type="button" class="text-button" data-action="select-thread" data-thread-id="${escapeHtml(event.threadId)}">Thread</button>` : ""}
        ${event.runId ? `<button type="button" class="text-button" data-action="select-run" data-run-id="${escapeHtml(event.runId)}">Run</button>` : ""}
        <span>${escapeHtml(formatRelative(event.createdAt))}</span>
      </div>
    </article>
  `;
}

function renderPoliciesPage() {
  return renderPlaceholderPage("Policies", "Rules for memory access, tools, outbound actions, Telegram, artifacts, and model escalation.", [
    "Memory access",
    "Tool permissions",
    "Outbound approval rules",
    "Inter-instance federation",
  ]);
}

function renderApprovalsPage() {
  return renderPlaceholderPage("Approvals", "A unified inbox for outbound messages, sensitive tools, memory writes, and generated artifacts.", [
    "No pending approvals",
  ]);
}

function renderSchedulerPage() {
  return renderPlaceholderPage("Scheduler", "Scheduled reminders, recurring tasks, group notifications, and execution history.", [
    "No scheduled tasks yet",
  ]);
}

function renderAuditLogPage() {
  return `
    <section class="page-stack">
      ${renderFilterBar("Search audit events...", ["User", "Action", "Target", "Status", "Date"])}
      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Audit Log</h2>
            <p>Run creation, tool use, artifacts, and policy-relevant actions.</p>
          </div>
          <span class="context-chip">${state.auditEvents.length} events</span>
        </div>
        <div class="table-list">
          ${state.auditEvents.length
            ? state.auditEvents.map(renderAuditEventRow).join("")
            : renderEmptyState("No audit events", "Actions will appear here after runs or tool calls.", "Audit Log")}
        </div>
      </section>
    </section>
  `;
}

function renderAuditEventRow(event) {
  return `
    <button type="button" class="data-row audit-row" data-action="${event.runId ? "select-run" : ""}" data-run-id="${event.runId ?? ""}">
      <span class="row-title">${escapeHtml(event.summary)}</span>
      ${statusBadge(event.status)}
      <span>${escapeHtml(event.action)}</span>
      <span>${escapeHtml(event.actorId)} · ${escapeHtml(event.actorType)}</span>
      <span>${escapeHtml(event.targetType)} · ${escapeHtml(event.targetId)}</span>
      <span>${event.channel ?? "system"}</span>
      <span>${formatRelative(event.createdAt)}</span>
    </button>
  `;
}

function renderSettingsPage() {
  return `
    <section class="page-stack">
      <section class="surface-hero">
        <span class="eyebrow">Instance configuration</span>
        <h2>Settings</h2>
        <p>Local instance settings and secret handles used by generated tools, model providers, and future always-on modules.</p>
        <div class="metric-card-grid">
          ${metricCard("Instance", state.instance?.id ?? "instance-local", state.instance?.name ?? "Local Agentic Assistant")}
          ${metricCard("Timezone", state.instance?.timeZone ?? "Europe/Madrid", state.instance?.locale ?? "ru-RU")}
          ${metricCard("Secret handles", String(state.secretHandles.length), "No raw values are exposed")}
        </div>
      </section>

      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Secret Handles</h2>
            <p>Register references to environment variables or external secret manager paths. The UI and APIs never store raw API keys.</p>
          </div>
          <span class="context-chip">redacted by design</span>
        </div>
        <form data-action="create-secret-handle" class="settings-form">
          <div class="composer-grid compact-grid">
            <label>
              <span>Handle</span>
              <input name="handle" placeholder="secret.telegram.bot" />
            </label>
            <label>
              <span>Label</span>
              <input name="label" placeholder="Telegram bot token" required />
            </label>
            <label>
              <span>Provider</span>
              <select name="provider">
                <option value="env">Environment variable</option>
                <option value="external">External secret manager</option>
              </select>
            </label>
            <label>
              <span>Secret ref</span>
              <input name="secretRef" placeholder="TELEGRAM_BOT_TOKEN" required />
            </label>
          </div>
          <label>
            <span>Scopes</span>
            <input name="scopes" placeholder="instance-local, tool:channel.telegram.bot" />
          </label>
          <div class="composer-bottom">
            <p class="composer-hint">Paste only references such as env var names or vault paths. Never paste the secret value itself.</p>
            <button type="submit" class="primary-button">Create Secret Handle</button>
          </div>
        </form>
      </section>

      <section class="card-grid">
        ${state.secretHandles.map(renderSecretHandleCard).join("") || emptyState("No secret handles", "Credentialed tools can be requested after a handle is registered.")}
      </section>
    </section>
  `;
}

function renderSecretHandleCard(secret) {
  return `
    <article class="tool-card">
      <div class="card-topline">
        <span>${escapeHtml(secret.provider)}</span>
        <span>${formatRelative(secret.updatedAt ?? secret.createdAt)}</span>
      </div>
      <h3>${escapeHtml(secret.handle)}</h3>
      <p>${escapeHtml(secret.label)}</p>
      <div class="context-list">
        <span>Ref: <code>${escapeHtml(secret.secretRef)}</code></span>
        <span>Scopes: ${(secret.scopes ?? []).map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ") || "instance-local"}</span>
      </div>
      <div class="card-actions">
        <button type="button" class="ghost-button danger-button" data-action="delete-secret-handle" data-secret-handle="${escapeHtml(secret.handle)}">Delete</button>
      </div>
    </article>
  `;
}

function metricCard(label, value, detail) {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function renderDiagnosticsPage() {
  return renderPlaceholderPage("Diagnostics", "Runtime health, migrations, generated tools, queues, recent errors, and log previews.", [
    "App ready",
    "Postgres healthy",
    "Redis healthy",
    "MinIO healthy",
    "SearXNG available",
    `${state.tools.length} tools loaded`,
  ]);
}

function renderCommandPalettePage() {
  return `
    <section class="surface-panel command-page">
      <h2>Command Palette</h2>
      <input class="large-search" placeholder="Search runs, conversations, tools, memories..." autofocus />
      <div class="command-grid">
        ${["New task", "Continue thread", "Open latest run", "Trace latest run", "Create tool build request", "Open settings"]
          .map((item) => `<button type="button" class="activity-item"><strong>${item}</strong><small>Quick action</small></button>`)
          .join("")}
      </div>
    </section>
  `;
}

function renderWizardPage(title, steps) {
  return `
    <section class="surface-panel wizard-page">
      <h2>${title}</h2>
      <div class="stepper">${steps.map((step, index) => `<span class="${index === 0 ? "active" : ""}">${index + 1}. ${step}</span>`).join("")}</div>
      <div class="wizard-body">
        ${renderEmptyState("Add API documentation", "Paste docs or upload OpenAPI, Markdown, PDF, or examples. The agent will propose a TypeScript tool contract.", "Start")}
      </div>
      <div class="action-row"><button class="ghost-button">Back</button><button class="primary-button">Next</button></div>
    </section>
  `;
}

function renderPlaceholderPage(title, description, items) {
  return `
    <section class="placeholder-layout">
      <article class="surface-panel placeholder-hero">
        <span class="eyebrow">Planned system layer</span>
        <h2>${title}</h2>
        <p>${description}</p>
      </article>
      <div class="card-grid">
        ${items.map((item) => `<article class="knowledge-card"><p>${escapeHtml(item)}</p></article>`).join("")}
      </div>
    </section>
  `;
}

function renderFilterBar(placeholder, filters) {
  return `
    <section class="filter-bar surface-panel">
      <input placeholder="${placeholder}" />
      <div>${filters.map((filter) => `<button type="button">${filter}</button>`).join("")}</div>
    </section>
  `;
}

function renderDashboardSkeleton() {
  return `
    <section class="dashboard-layout">
      <div class="dashboard-primary">
        <div class="skeleton-block tall"></div>
        <div class="skeleton-block"></div>
        <div class="skeleton-block"></div>
      </div>
      <aside class="dashboard-secondary">
        <div class="skeleton-block"></div>
        <div class="skeleton-block"></div>
      </aside>
    </section>
  `;
}

function renderErrorState(error) {
  return `
    <section class="surface-panel error-state">
      <h2>Workspace unavailable</h2>
      <p>${escapeHtml(error)}</p>
      <button type="button" class="primary-button" data-action="refresh">Retry</button>
    </section>
  `;
}

function renderEmptyState(title, body, action) {
  return `
    <article class="empty-state">
      <strong>${title}</strong>
      <p>${body}</p>
      <span>${action}</span>
    </article>
  `;
}

async function submitRun(form) {
  const data = new FormData(form);
  const task = String(data.get("task") ?? "").trim();
  if (!task) return;

  const threadMode = String(data.get("threadMode") ?? "new");
  const threadId = threadMode === "continue" ? String(data.get("threadId") ?? "") : "";
  const requesterUserId = String(data.get("requesterUserId") ?? "user-admin");
  const channel = String(data.get("channel") ?? "web");
  const files = data.getAll("files").filter((file) => file instanceof File && file.size > 0);

  setComposerBusy(form, true);

  try {
    const attachments = await Promise.all(files.map(readAttachment));
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task,
        requesterUserId,
        channel,
        threadId: threadId || undefined,
        attachments,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Failed to start run");

    state.activeRunId = body.run.id;
    state.activeThreadId = body.run.threadId ?? state.activeThreadId;
    await refreshData();
    navigate(`run/${body.run.id}`);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function cancelRun(runId) {
  try {
    const data = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Cancelled from the web console." }),
    });
    const index = state.runs.findIndex((run) => run.id === runId);
    if (index >= 0) state.runs[index] = data.run;
    state.notice = {
      type: "success",
      title: "Run cancelled",
      body: "The run is now terminal; late tool or model results will be ignored.",
    };
    state.stream?.close();
    state.stream = undefined;
    await refreshData();
  } catch (error) {
    state.notice = {
      type: "error",
      title: "Could not cancel run",
      body: error instanceof Error ? error.message : String(error),
    };
    render();
  }
}

async function saveModelTiers(form) {
  const formData = new FormData(form);
  const tiers = ["S", "M", "L", "XL"].map((tier) => ({
    tier,
    models: String(formData.get(`models-${tier}`) ?? "")
      .split(/\n|,/)
      .map((model) => model.trim())
      .filter(Boolean),
    maxAttempts: Number(formData.get(`maxAttempts-${tier}`) ?? 2),
    escalateOnFailure: formData.has(`escalateOnFailure-${tier}`),
  }));

  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/settings/model-tiers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tiers }),
    });
    state.tiers = data.tiers ?? [];
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function createModelProvider(form) {
  const formData = new FormData(form);
  const provider = {
    label: String(formData.get("label") ?? "").trim(),
    kind: String(formData.get("kind") ?? "chat"),
    providerType: String(formData.get("providerType") ?? "openai-compatible"),
    baseUrl: String(formData.get("baseUrl") ?? "").trim() || undefined,
    modelIds: String(formData.get("modelIds") ?? "")
      .split(/\n|,/)
      .map((model) => model.trim())
      .filter(Boolean),
    defaultModel: String(formData.get("defaultModel") ?? "").trim() || undefined,
    apiKeySecretHandle: String(formData.get("apiKeySecretHandle") ?? "").trim() || undefined,
    dimensions: String(formData.get("dimensions") ?? "").trim()
      ? Number(formData.get("dimensions"))
      : undefined,
  };

  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/model-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(provider),
    });
    state.modelProviders = [...state.modelProviders, data.provider].filter(Boolean);
    form.reset();
    await refreshData();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function deleteModelProvider(providerId) {
  try {
    await fetchJson(`/api/model-providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
    state.modelProviders = state.modelProviders.filter((provider) => provider.id !== providerId);
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function saveGroupProfile(form) {
  const formData = new FormData(form);
  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/group-profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? ""),
        preferences: { notes: String(formData.get("preferencesNotes") ?? "") },
      }),
    });
    state.groupProfile = data.groupProfile;
    await refreshData();
    navigate("group-profile");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function createUser(form) {
  const formData = new FormData(form);
  setComposerBusy(form, true);
  try {
    await fetchJson("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: String(formData.get("displayName") ?? ""),
        role: String(formData.get("role") ?? "member"),
        roles: parseListInput(formData.get("roles")),
      }),
    });
    form.reset();
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function updateUser(form) {
  const formData = new FormData(form);
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return;
  setComposerBusy(form, true);
  try {
    await fetchJson(`/api/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: String(formData.get("displayName") ?? ""),
        roles: parseListInput(formData.get("roles")),
      }),
    });
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function deleteUser(userId) {
  if (!confirm(`Delete user ${userId}? Channel identities will be removed too.`)) return;
  try {
    await fetchJson(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function createChannelIdentity(form) {
  const formData = new FormData(form);
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return;
  setComposerBusy(form, true);
  try {
    await fetchJson(`/api/users/${encodeURIComponent(userId)}/channel-identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: String(formData.get("provider") ?? ""),
        providerUserId: String(formData.get("providerUserId") ?? ""),
        allowStatus: String(formData.get("allowStatus") ?? "allowed"),
      }),
    });
    form.reset();
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function updateChannelIdentity(identityId, update) {
  try {
    await fetchJson(`/api/channel-identities/${encodeURIComponent(identityId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function deleteChannelIdentity(identityId) {
  try {
    await fetchJson(`/api/channel-identities/${encodeURIComponent(identityId)}`, { method: "DELETE" });
    await refreshData();
    navigate("users");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function updateMemoryStatus(memoryId, status) {
  try {
    const data = await fetchJson(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    state.memories = [data.memory, ...state.memories.filter((memory) => memory.id !== data.memory.id)];
    state.selectedMemoryId = data.memory.id;
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function saveMemory(form) {
  const formData = new FormData(form);
  const memoryId = String(formData.get("memoryId") ?? "");
  const payload = {
    title: String(formData.get("title") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    reusableProcedure: String(formData.get("reusableProcedure") ?? ""),
    tags: parseListInput(formData.get("tags")),
    scope: String(formData.get("scope") ?? "global"),
    scopeId: normalizeOptionalInput(formData.get("scopeId")),
    status: String(formData.get("status") ?? "proposed"),
    confidence: Number(formData.get("confidence") ?? 0.75),
    sensitivity: String(formData.get("sensitivity") ?? "normal"),
    evidence: parseListInput(formData.get("evidence")),
  };
  setComposerBusy(form, true);
  try {
    const data = await fetchJson(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.memories = [data.memory, ...state.memories.filter((memory) => memory.id !== data.memory.id)];
    state.selectedMemoryId = data.memory.id;
    state.notice = {
      title: "Memory updated",
      body: `${data.memory.title} is saved with ${data.memory.scope}${data.memory.scopeId ? `:${data.memory.scopeId}` : ""} scope.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function rebuildMemoryEmbeddings() {
  try {
    const data = await fetchJson("/api/memories/reembed", { method: "POST" });
    await refreshData();
    state.notice = {
      title: "Memory embeddings rebuilt",
      body: `${data.updated ?? 0} memory item${data.updated === 1 ? "" : "s"} re-embedded for the active provider.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function runToolHealthchecks() {
  try {
    const result = await fetchJson("/api/tools/health");
    const failed = (result.tools ?? []).filter((tool) => !tool.ok);
    await refreshData();
    state.notice = {
      title: failed.length ? "Tool healthchecks failed" : "Tool healthchecks passed",
      body: failed.length
        ? `${failed.length} tool healthcheck${failed.length === 1 ? "" : "s"} failed.`
        : `Healthchecks passed for ${(result.tools ?? []).length} tool${(result.tools ?? []).length === 1 ? "" : "s"}.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function updateToolService(toolName, action) {
  try {
    const data = await fetchJson(
      `/api/tool-services/${encodeURIComponent(toolName)}/${encodeURIComponent(action)}`,
      { method: "POST" },
    );
    state.toolServices = [
      data.service,
      ...state.toolServices.filter((service) => service.toolName !== data.service.toolName),
    ].sort((a, b) => a.toolName.localeCompare(b.toolName));
    state.toolServiceLogs = await fetchJson("/api/tool-services/logs?limit=80").then((logsData) => logsData.logs ?? []);
    state.notice = {
      title: `Service ${action}`,
      body: `${data.service.displayName || data.service.toolName}: ${data.service.status}. ${data.service.detail}`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

function parseListInput(value) {
  return String(value ?? "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalInput(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

async function createToolBuildRequest(form) {
  const formData = new FormData(form);
  const qaCriteria = String(formData.get("qaCriteria") ?? "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  const capability = String(formData.get("capability") ?? "").trim();
  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/tool-build-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: capability || undefined,
        displayName: String(formData.get("displayName") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        sourceRunId: String(formData.get("sourceRunId") ?? "") || undefined,
        sourceSpanId: String(formData.get("sourceSpanId") ?? "") || undefined,
        taskSummary: String(formData.get("taskSummary") ?? "") || undefined,
        desiredToolName: String(formData.get("desiredToolName") ?? "") || undefined,
        replacesToolName: String(formData.get("replacesToolName") ?? "") || undefined,
        replacesVersion: String(formData.get("replacesVersion") ?? "") || undefined,
        feedback: String(formData.get("feedback") ?? "") || undefined,
        startupMode: String(formData.get("startupMode") ?? "") || undefined,
        qaCriteria,
        credentialHandles: parseListInput(formData.get("credentialHandles")),
        credentialNotes: String(formData.get("credentialNotes") ?? "") || undefined,
      }),
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    state.notice = {
      title: "Tool request created",
      body: `${data.request.capability} is now in the Tool Builds queue.`,
      route: "tool-builds",
      actionLabel: "Open queue",
    };
    form.reset();
    if (formData.get("sourceSpanId")) {
      navigate("tool-builds");
    } else {
      render();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function deleteTool(toolName) {
  if (!window.confirm(`Delete generated tool ${toolName}? Built-in tools cannot be deleted.`)) return;
  try {
    await fetchJson(`/api/tools/generated-modules/${encodeURIComponent(toolName)}`, { method: "DELETE" });
    state.tools = state.tools.filter((tool) => tool.name !== toolName);
    if (state.selectedToolName === toolName) {
      state.selectedToolName = state.tools[0]?.name;
    }
    state.notice = {
      title: "Tool deleted",
      body: `${toolName} was removed from the generated tool registry.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function runToolBuild(buildId) {
  try {
    const data = await fetchJson(`/api/tool-build-requests/${encodeURIComponent(buildId)}/run`, {
      method: "POST",
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    const tools = await fetchJson("/api/tools");
    state.tools = tools.tools ?? state.tools;
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function createSecretHandle(form) {
  const formData = new FormData(form);
  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/secret-handles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: normalizeOptionalInput(formData.get("handle")),
        label: String(formData.get("label") ?? ""),
        provider: String(formData.get("provider") ?? "env"),
        secretRef: String(formData.get("secretRef") ?? ""),
        scopes: parseListInput(formData.get("scopes")),
      }),
    });
    state.secretHandles = [
      data.secretHandle,
      ...state.secretHandles.filter((item) => item.handle !== data.secretHandle.handle),
    ];
    state.notice = {
      title: "Secret handle saved",
      body: `${data.secretHandle.handle} now points to ${data.secretHandle.secretRef}.`,
    };
    form.reset();
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function deleteSecretHandle(handle) {
  if (!window.confirm(`Delete secret handle ${handle}? Tools that reference it will need a replacement handle.`)) return;
  try {
    await fetchJson(`/api/secret-handles/${encodeURIComponent(handle)}`, { method: "DELETE" });
    state.secretHandles = state.secretHandles.filter((item) => item.handle !== handle);
    state.notice = {
      title: "Secret handle deleted",
      body: `${handle} was removed from the local registry.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function reworkToolBuild(form) {
  const formData = new FormData(form);
  const buildId = String(formData.get("buildId") ?? "");
  setComposerBusy(form, true);
  try {
    const data = await fetchJson(`/api/tool-build-requests/${encodeURIComponent(buildId)}/rework`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        feedback: String(formData.get("feedback") ?? ""),
      }),
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    form.reset();
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function stopToolBuild(buildId) {
  try {
    const data = await fetchJson(`/api/tool-build-requests/${encodeURIComponent(buildId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Stopped from Tool Builds UI by operator." }),
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function deleteToolBuild(buildId) {
  if (!window.confirm("Delete this tool build request from the queue?")) return;
  try {
    await fetchJson(`/api/tool-build-requests/${encodeURIComponent(buildId)}`, {
      method: "DELETE",
    });
    state.buildRequests = state.buildRequests.filter((item) => item.id !== buildId);
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function deleteConversationThread(threadId) {
  const thread = state.conversations.find((item) => item.id === threadId);
  const relatedRuns = state.runs.filter((run) => run.threadId === threadId);
  const title = thread?.title ?? threadId;
  if (
    !window.confirm(
      `Delete conversation "${title}" and ${relatedRuns.length} related run(s), trace logs, and artifact metadata? This cannot be undone.`,
    )
  ) {
    return;
  }

  try {
    await fetchJson(`/api/conversation-threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
    state.conversations = state.conversations.filter((item) => item.id !== threadId);
    state.runs = state.runs.filter((run) => run.threadId !== threadId);
    if (state.activeThreadId === threadId) state.activeThreadId = undefined;
    if (state.route.page === "conversation" && state.route.id === threadId) {
      navigate("conversations");
      return;
    }
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function reworkTool(form) {
  const formData = new FormData(form);
  const toolName = String(formData.get("toolName") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? toolName).trim();
  const capability = String(formData.get("capability") ?? toolName).trim();
  const feedback = String(formData.get("feedback") ?? "").trim();
  const replacesVersion = String(formData.get("replacesVersion") ?? "").trim();
  const startupMode = String(formData.get("startupMode") ?? "").trim();
  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/tool-build-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability,
        displayName,
        reason: `Change request for ${displayName || toolName}:\n${feedback}`,
        desiredToolName: toolName,
        feedback,
        replacesToolName: toolName,
        replacesVersion: replacesVersion || undefined,
        startupMode: startupMode || undefined,
        qaCriteria: [
          "The new version preserves the tool name and creates a higher semantic version.",
          "Requested behavior is covered by a focused regression test and a manual smoke test.",
          "Replacement TypeScript module passes isolated QA before it is promoted as the active version.",
          "Tool metadata, docs, schemas, required settings/secrets, and examples remain agent-readable.",
        ],
      }),
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    state.notice = {
      title: "Tool change request created",
      body: `${data.request.displayName || data.request.capability} will build a new version from ${replacesVersion || "the active version"}.`,
    };
    navigate("tool-builds");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function activateToolVersion(form) {
  const formData = new FormData(form);
  const toolName = String(formData.get("toolName") ?? "").trim();
  const version = String(formData.get("version") ?? "").trim();
  if (!toolName || !version) return;
  setComposerBusy(form, true);
  try {
    const data = await fetchJson(`/api/tools/generated-modules/${encodeURIComponent(toolName)}/activate-version`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
    state.tools = [data.tool, ...state.tools.filter((tool) => tool.name !== data.tool.name)];
    state.selectedToolName = data.tool.name;
    state.notice = {
      title: "Tool version activated",
      body: `${data.tool.displayName || data.tool.name} now uses v${data.tool.version}.`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

function setComposerBusy(form, isBusy) {
  for (const element of form.elements) {
    element.disabled = isBusy;
  }
}

async function readAttachment(file) {
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    contentBase64: await fileToBase64(file),
    description: "User attached input file",
  };
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

function updateComposerMode(form) {
  if (!form) return;
  const isContinue = form.querySelector('input[name="threadMode"][value="continue"]')?.checked;
  const threadSelect = form.querySelector('select[name="threadId"]');
  const threadField = form.querySelector(".thread-field");
  if (threadSelect) threadSelect.disabled = !isContinue;
  if (threadField instanceof HTMLElement) threadField.hidden = !isContinue;
  if (isContinue && threadSelect instanceof HTMLSelectElement) {
    state.dashboardThreadId = threadSelect.value || state.dashboardThreadId;
  }
}

function hydrateAfterRender() {
  for (const form of document.querySelectorAll("form.composer-form")) updateComposerMode(form);
  updateLiveTimers();
  requestAnimationFrame(() => {
    drawGraphEdges();
    highlightGraphRelations(state.hoveredGraphSpanId ?? state.selectedSpanId);
  });
}

function drawGraphEdges() {
  const canvas = document.querySelector("[data-graph-canvas]");
  const board = document.querySelector("[data-graph-board]");
  const svg = document.querySelector("[data-graph-edge-layer]");
  if (!(canvas instanceof HTMLElement) || !(board instanceof HTMLElement) || !(svg instanceof SVGSVGElement)) return;

  const nodes = [...board.querySelectorAll(".graph-node")].filter((node) => node instanceof HTMLElement);
  const nodeBySpan = new Map(nodes.map((node) => [node.dataset.spanId, node]));
  const width = Math.max(board.scrollWidth, board.offsetWidth);
  const height = Math.max(board.scrollHeight, board.offsetHeight, 240);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const defs = `
    <defs>
      <marker id="graph-arrow-head" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="graph-arrow-head-default" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
      <marker id="graph-arrow-head-dependency" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="graph-arrow-head-dependency" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
      <marker id="graph-arrow-head-highlighted" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="graph-arrow-head-highlighted" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
      <marker id="graph-arrow-head-failed" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="graph-arrow-head-failed" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
      <marker id="graph-arrow-head-failed-highlighted" viewBox="0 0 10 10" refX="8.8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="graph-arrow-head-failed-highlighted" d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
    </defs>
  `;

  const paths = [];
  for (const node of nodes) {
    const parent = nodeBySpan.get(node.dataset.parentSpanId);
    if (parent) paths.push(renderGraphEdge(parent, node, "parent"));

    const dependencyIds = (node.dataset.dependencySpanIds ?? "").split(",").filter(Boolean);
    for (const dependencyId of dependencyIds) {
      const dependency = nodeBySpan.get(dependencyId);
      if (dependency) paths.push(renderGraphEdge(dependency, node, "dependency"));
    }
  }

  svg.innerHTML = defs + paths.join("");
}

function renderGraphEdge(fromNode, toNode, kind) {
  const fromRect = fromNode.getBoundingClientRect();
  const toRect = toNode.getBoundingClientRect();
  const canvasRect = document.querySelector("[data-graph-canvas]").getBoundingClientRect();
  const x1 = fromRect.right - canvasRect.left;
  const y1 = fromRect.top + fromRect.height / 2 - canvasRect.top;
  const x2 = toRect.left - canvasRect.left;
  const y2 = toRect.top + toRect.height / 2 - canvasRect.top;
  const bend = Math.max(38, Math.min(140, Math.abs(x2 - x1) * 0.45));
  const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  const pointsToFailed = toNode.classList.contains("failed");
  const markerId = pointsToFailed
    ? "graph-arrow-head-failed"
    : kind === "dependency"
      ? "graph-arrow-head-dependency"
      : "graph-arrow-head";
  return `<path class="graph-edge ${kind} ${pointsToFailed ? "failed-target" : ""}" d="${d}" data-from-span-id="${fromNode.dataset.spanId}" data-to-span-id="${toNode.dataset.spanId}" data-default-marker="${markerId}" marker-end="url(#${markerId})"></path>`;
}

function highlightGraphRelations(spanId) {
  const nodes = [...document.querySelectorAll(".graph-node")];
  const edges = [...document.querySelectorAll(".graph-edge")];
  if (!nodes.length) return;

  const connected = new Set();
  if (spanId) {
    connected.add(spanId);
    for (const edge of edges) {
      if (edge.dataset.fromSpanId === spanId || edge.dataset.toSpanId === spanId) {
        connected.add(edge.dataset.fromSpanId);
        connected.add(edge.dataset.toSpanId);
        edge.classList.add("is-highlighted");
        edge.setAttribute(
          "marker-end",
          edge.classList.contains("failed-target")
            ? "url(#graph-arrow-head-failed-highlighted)"
            : "url(#graph-arrow-head-highlighted)",
        );
      } else {
        edge.classList.remove("is-highlighted");
        edge.setAttribute("marker-end", `url(#${edge.dataset.defaultMarker ?? "graph-arrow-head"})`);
      }
    }
  } else {
    for (const edge of edges) {
      edge.classList.remove("is-highlighted");
      edge.setAttribute("marker-end", `url(#${edge.dataset.defaultMarker ?? "graph-arrow-head"})`);
    }
  }

  for (const node of nodes) {
    const isConnected = spanId && connected.has(node.dataset.spanId);
    node.classList.toggle("is-highlighted", Boolean(spanId && node.dataset.spanId === spanId));
    node.classList.toggle("is-connected", Boolean(isConnected && node.dataset.spanId !== spanId));
    node.classList.toggle("is-dimmed", Boolean(spanId && !isConnected));
  }
}

function activeRun() {
  if ((state.route.page === "run" || state.route.page === "trace") && state.route.id) {
    return state.runs.find((run) => run.id === state.route.id);
  }
  return state.runs.find((run) => run.id === state.activeRunId) ?? state.runs[0];
}

function activeThread() {
  return (
    state.conversations.find((thread) => thread.id === state.activeThreadId) ??
    state.conversations.find((thread) => thread.id === activeRun()?.threadId) ??
    state.conversations[0]
  );
}

function latestEvent(run) {
  return [...(run.events ?? [])].reverse().find((event) => event.title || event.detail);
}

function routeMeta() {
  const item = routes.flatMap((group) => group.items).find((candidate) => candidate.id === state.route.page);
  if (state.route.page === "run") return { label: "Run Workspace", description: "Final answer first, execution context second." };
  if (state.route.page === "conversation") return { label: "Conversation Detail", description: "Thread messages, runs, and compact context." };
  if (state.route.page === "search") return { label: "Command Palette", description: "Search, jump, and trigger quick actions." };
  return item ?? routes[0].items[0];
}

function isActiveNav(id) {
  if (id === "runs" && state.route.page === "run") return true;
  if (id === "trace" && state.route.page === "trace") return true;
  if (id === "conversations" && state.route.page === "conversation") return true;
  return state.route.page === id;
}

function pendingApprovalCount() {
  return 0;
}

function connectRunStream(id) {
  state.stream?.close();
  state.stream = undefined;
  if (!id || !window.EventSource) return;

  const run = state.runs.find((candidate) => candidate.id === id);
  if (run && !["queued", "running"].includes(run.status)) return;

  const stream = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  stream.addEventListener("run", (event) => {
    const data = JSON.parse(event.data);
    const index = state.runs.findIndex((candidate) => candidate.id === data.run.id);
    if (index >= 0) state.runs[index] = data.run;
    else state.runs.unshift(data.run);
    state.activeRunId = data.run.id;
    if (!["queued", "running"].includes(data.run.status)) {
      stream.close();
      void refreshData();
    }
    render();
  });
  stream.addEventListener("error", () => stream.close());
  state.stream = stream;
}

function connectServiceLogStream() {
  if (state.serviceLogStream || !window.EventSource) return;

  const stream = new EventSource("/api/tool-services/logs/events");
  stream.addEventListener("service-log", (event) => {
    const data = JSON.parse(event.data);
    if (data.log) {
      upsertServiceLog(data.log);
      render();
    }
  });
  stream.addEventListener("error", () => {
    stream.close();
    state.serviceLogStream = undefined;
  });
  state.serviceLogStream = stream;
}

function upsertServiceLog(log) {
  state.toolServiceLogs = [
    log,
    ...state.toolServiceLogs.filter((candidate) => candidate.id !== log.id),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 80);
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
  const nodes = [...bySpan.values()].sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  const titleBySpan = new Map(nodes.map((node) => [node.spanId, node.title]));
  return nodes.map((node) => ({
    ...node,
    parentTitle: node.parentSpanId ? titleBySpan.get(node.parentSpanId) : undefined,
    dependencySpanIds: dependencySpanIdsFor(node),
  }));
}

function applyTraceFilters(nodes) {
  return nodes.filter((node) =>
    ["actor", "activity", "status", "tool", "modelTier"].every((key) => {
      const selected = state.traceFilters[key];
      if (!selected || selected === "all") return true;
      return traceFilterValue(node, key) === selected;
    }),
  );
}

function traceFilterOptions(nodes, key) {
  return unique(nodes.map((node) => traceFilterValue(node, key)).filter(Boolean)).sort((a, b) =>
    a.localeCompare(b),
  );
}

function traceFilterValue(node, key) {
  if (key === "actor") return node.actor;
  if (key === "activity") return node.activity;
  if (key === "status") return node.status;
  if (key === "tool") return node.activity === "tool" ? node.actor : undefined;
  if (key === "modelTier") return modelTierFor(node);
  return undefined;
}

function filterEventsForTrace(events, nodes) {
  if (!hasActiveTraceFilters()) return events;
  const visibleSpanIds = new Set(nodes.map((node) => node.spanId));
  return events.filter((event) => visibleSpanIds.has(event.spanId));
}

function hasActiveTraceFilters() {
  return Object.values(state.traceFilters).some((value) => value && value !== "all");
}

function memoryEntriesFromPayload(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.filter((item) => item && typeof item === "object" && typeof item.title === "string");
}

function artifactsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const artifacts = [];
  if (isArtifactLike(payload.artifact)) artifacts.push(payload.artifact);
  if (Array.isArray(payload.artifacts)) artifacts.push(...payload.artifacts.filter(isArtifactLike));
  if (payload.workerResult && typeof payload.workerResult === "object" && Array.isArray(payload.workerResult.artifacts)) {
    artifacts.push(...payload.workerResult.artifacts.filter(isArtifactLike));
  }
  return artifacts;
}

function normalizeArtifactForCard(artifact) {
  return {
    id: artifact.id ?? artifact.filename ?? "artifact",
    runId: artifact.runId ?? activeRun()?.id ?? "",
    kind: artifact.kind ?? "output",
    filename: artifact.filename ?? artifact.id ?? "artifact",
    mimeType: artifact.mimeType ?? "application/octet-stream",
    sizeBytes: Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : 0,
    url: artifact.url ?? "#",
    description: artifact.description,
    contentPreview: artifact.contentPreview,
  };
}

function isArtifactLike(value) {
  return Boolean(value) && typeof value === "object" && (typeof value.url === "string" || typeof value.filename === "string");
}

function toolSummaryFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const lines = [];
  if (typeof payload.tool === "string") lines.push(`Tool: ${payload.tool}`);
  if (typeof payload.query === "string") lines.push(`Query: ${payload.query}`);
  if (typeof payload.ok === "boolean") lines.push(`Result: ${payload.ok ? "ok" : "failed"}`);
  if (Array.isArray(payload.data)) lines.push(`Data items: ${payload.data.length}`);
  if (payload.input && typeof payload.input === "object") {
    lines.push(`Input: ${truncate(JSON.stringify(payload.input), 700)}`);
  }
  if (typeof payload.content === "string") lines.push(truncate(payload.content, 1200));
  return lines.join("\n");
}

function graphColumn(node) {
  const title = node.title.toLowerCase();
  if (node.activity === "coordination") return "Coordinator";
  if (node.activity === "memory" || node.activity === "planning" || title.includes("classified")) return "Memory & Classifier";
  if (node.activity === "tool" || node.activity === "artifact") return "Tools";
  if (
    node.activity === "worker" ||
    node.activity === "review" ||
    node.actor.startsWith("worker") ||
    node.actor.startsWith("reviewer")
  ) {
    return "Workers";
  }
  if (node.activity === "synthesis" || node.actor === "synthesizer" || title.includes("synthesized")) return "Synthesis";
  return "Output";
}

function traceGraphColumns(nodes, depths = traceGraphDepths(nodes)) {
  if (state.traceGraphLayout !== "depth") {
    return ["Coordinator", "Memory & Classifier", "Workers", "Tools", "Synthesis", "Output"];
  }
  const maxDepth = Math.max(0, ...nodes.map((node) => depths.get(node.spanId) ?? 0));
  return Array.from({ length: maxDepth + 1 }, (_value, index) => `Level ${index + 1}`);
}

function traceGraphColumnFor(node, layout, depths) {
  if (layout !== "depth") return graphColumn(node);
  const depth = depths.get(node.spanId) ?? 0;
  return `Level ${depth + 1}`;
}

function traceGraphDepths(nodes) {
  const nodeBySpan = new Map(nodes.map((node) => [node.spanId, node]));
  const depthBySpan = new Map();
  const visiting = new Set();

  const depthFor = (node) => {
    if (depthBySpan.has(node.spanId)) return depthBySpan.get(node.spanId);
    if (!node.parentSpanId || !nodeBySpan.has(node.parentSpanId) || visiting.has(node.spanId)) {
      depthBySpan.set(node.spanId, 0);
      return 0;
    }
    visiting.add(node.spanId);
    const parentDepth = depthFor(nodeBySpan.get(node.parentSpanId));
    visiting.delete(node.spanId);
    const depth = parentDepth + 1;
    depthBySpan.set(node.spanId, depth);
    return depth;
  };

  for (const node of nodes) depthFor(node);
  return depthBySpan;
}

function inferCapabilityFromSpan(node) {
  const payload = node.payload && typeof node.payload === "object" ? node.payload : {};
  if (typeof payload.tool === "string") return payload.tool;
  if (typeof payload.toolName === "string") return payload.toolName;
  if (typeof payload.capability === "string") return payload.capability;
  if (node.actor?.startsWith("web.search")) return "web-search";
  if (node.actor?.includes("browser")) return "browser-operate";
  if (node.activity === "tool") return node.actor || "tool-rework";
  if (node.activity === "artifact") return "artifact-generation";
  if (node.status === "failed") return `${node.activity || "agent"}-bug`;
  return "agent-workflow-bug";
}

function dependencySpanIdsFor(node) {
  if (!node?.payload || typeof node.payload !== "object") return [];
  const spanIds = node.payload.dependencySpanIds;
  return Array.isArray(spanIds) ? spanIds.filter((spanId) => typeof spanId === "string") : [];
}

function modelTierFor(nodeOrEvent) {
  if (!nodeOrEvent?.payload || typeof nodeOrEvent.payload !== "object") return undefined;
  const tier = nodeOrEvent.payload.modelTier;
  return typeof tier === "string" ? tier : undefined;
}

function modelTierSummaryForRun(run) {
  const tiers = unique((run.events ?? []).map(modelTierFor).filter(Boolean));
  return tiers.length ? `Tier ${tiers.join(", ")}` : "";
}

function orderTraceNodes(nodes, prioritizeActive) {
  const statusRank = (status) => {
    if (["started", "running", "queued"].includes(status)) return 0;
    if (status === "failed") return 1;
    return 2;
  };
  return [...nodes].sort((a, b) => {
    if (prioritizeActive) {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
    }
    return a.firstTimestamp.localeCompare(b.firstTimestamp);
  });
}

function runProgress(run) {
  if (["completed", "failed", "cancelled"].includes(run.status)) return 100;
  const eventCount = run.events?.length ?? 0;
  return Math.min(88, Math.max(12, eventCount * 12));
}

function statusBadge(status) {
  return `<span class="status-badge ${status}">${status}</span>`;
}

function miniInsight(label, value) {
  return `<div class="mini-insight"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatRunDuration(run) {
  const started = new Date(run.createdAt).getTime();
  const ended = ["running", "queued"].includes(run.status) ? Date.now() : new Date(run.updatedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "0 ms";
  return formatDuration(Math.max(0, ended - started));
}

function formatNodeDuration(node) {
  if (typeof node.durationMs === "number") return formatDuration(node.durationMs);
  if (node.startedAt && node.completedAt) {
    const started = new Date(node.startedAt).getTime();
    const completed = new Date(node.completedAt).getTime();
    if (Number.isFinite(started) && Number.isFinite(completed)) {
      return formatDuration(Math.max(0, completed - started));
    }
  }
  if (!node.startedAt || !["started", "running", "queued"].includes(node.status)) return "-";
  const started = new Date(node.startedAt).getTime();
  return Number.isFinite(started) ? formatDuration(Math.max(0, Date.now() - started)) : "running";
}

function formatDuration(durationMs) {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`;
}

function formatRelative(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function updateLiveTimers() {
  for (const element of document.querySelectorAll("[data-live-run-duration]")) {
    const run = state.runs.find((candidate) => candidate.id === element.dataset.liveRunDuration);
    if (run) element.textContent = formatRunDuration(run);
  }
  const run = activeRun();
  if (!run) return;
  const nodes = buildTraceNodes(run.events ?? []);
  for (const element of document.querySelectorAll("[data-live-node-duration]")) {
    const node = nodes.find((candidate) => candidate.spanId === element.dataset.liveNodeDuration);
    if (node) element.textContent = formatNodeDuration(node);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed: ${url}`);
  return data;
}

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function tierLabel(tier) {
  const labels = {
    S: "S · fast and cheap",
    M: "M · everyday work",
    L: "L · harder reasoning",
    XL: "XL · strongest fallback",
  };
  return labels[tier] ?? `Tier ${tier}`;
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function unique(values) {
  return [...new Set(values)];
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function renderMarkdown(value) {
  const normalized = String(value ?? "").replace(
    /-\s*([^\n:]+):\s*\n(\/api\/runs\/[^\s]+)/g,
    "- [$1]($2)",
  );
  const lines = normalized.split("\n");
  const html = [];
  let listDepth = 0;

  const closeLists = (targetDepth = 0) => {
    while (listDepth > targetDepth) {
      html.push("</ul>");
      listDepth -= 1;
    }
  };

  for (const line of lines) {
    const artifactLine = line.match(/^\s*[-*]\s*\[?([^\]\n:]+)\]?\((\/api\/runs\/[^)\s]+)\)\s*$/);
    const sameLineArtifact = line.match(/^\s*[-*]\s*([^:\n]+):\s*(\/api\/runs\/\S+)\s*$/);
    if (artifactLine || sameLineArtifact) {
      closeLists();
      html.push(renderMarkdownLine(line));
      continue;
    }

    const item = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (item) {
      const depth = Math.min(6, Math.floor(item[1].replaceAll("\t", "  ").length / 2) + 1);
      while (listDepth < depth) {
        html.push('<ul class="markdown-list">');
        listDepth += 1;
      }
      closeLists(depth);
      html.push(`<li>${renderInlineMarkdown(item[2])}</li>`);
      continue;
    }

    closeLists();
    if (!line.trim()) {
      html.push("<br>");
      continue;
    }
    html.push(`${renderMarkdownLine(line)}<br>`);
  }

  closeLists();
  return html.join("").replace(/(?:<br>)+$/g, "");
}

function renderMarkdownLine(line) {
  const artifactLine = line.match(/^\s*[-*]\s*\[?([^\]\n:]+)\]?\((\/api\/runs\/[^)\s]+)\)\s*$/);
  if (artifactLine) {
    return renderInlineArtifactLink(artifactLine[1], artifactLine[2]);
  }

  const sameLineArtifact = line.match(/^\s*[-*]\s*([^:\n]+):\s*(\/api\/runs\/\S+)\s*$/);
  if (sameLineArtifact) {
    return renderInlineArtifactLink(sameLineArtifact[1], sameLineArtifact[2]);
  }

  return renderInlineMarkdown(line);
}

function renderInlineMarkdown(value) {
  let html = escapeHtml(normalizeInlineMath(value));
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)/g,
    (_match, label, url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  html = html.replace(
    /(^|[\s(])((?:https?:\/\/|\/api\/runs\/)\S+)/g,
    (_match, prefix, url) => `${prefix}<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${url}</a>`,
  );
  return html;
}

function normalizeInlineMath(value) {
  return String(value ?? "")
    .replace(/\$\\rightarrow\$/g, "→")
    .replace(/\$\\leftarrow\$/g, "←")
    .replace(/\$\\to\$/g, "→")
    .replace(/\$\\geq?\$/g, "≥")
    .replace(/\$\\leq?\$/g, "≤")
    .replace(/\$\\pm\$/g, "±")
    .replace(/\\rightarrow/g, "→")
    .replace(/\\leftarrow/g, "←")
    .replace(/\\to/g, "→");
}

function renderInlineArtifactLink(filename, url) {
  return `<a class="inline-artifact-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><strong>${escapeHtml(filename.trim())}</strong><span>${escapeHtml(url)}</span></a>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
