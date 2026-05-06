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
  toolPackageRunners: [],
  toolServices: [],
  toolServiceLogs: [],
  toolServiceEvents: [],
  toolMigrations: [],
  toolPromotions: [],
  toolSettings: [],
  buildRequests: [],
  investigations: [],
  investigationModal: undefined,
  investigationModalNotice: undefined,
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
  dataFingerprint: undefined,
  refreshInFlight: false,
  pendingSoftRender: false,
  composerDraft: undefined,
  expandedPanels: new Set(),
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
  if (form.dataset.action === "create-investigation") {
    void createInvestigation(form);
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
  if (form.dataset.action === "update-tool-service-policy") {
    void updateToolServiceRestartPolicy(form);
  }
  if (form.dataset.action === "save-tool-settings") {
    void saveToolRuntimeSettings(form);
  }
  if (form.dataset.action === "import-tool-package") {
    void importToolPackageManifest(form);
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
    eventId,
    investigationId,
    investigationStatus,
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
  if (actionName === "reload-generated-tools") {
    void reloadGeneratedTools();
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
  if (actionName === "allow-event-identity" && eventId) {
    void allowEventIdentity(eventId);
  }
  if (actionName === "open-investigation-modal" && spanId) {
    openInvestigationModalForSpan(spanId);
  }
  if (actionName === "close-investigation-modal") {
    closeInvestigationModal();
  }
  if (actionName === "stop-propagation") {
    event.stopPropagation();
  }
  if (actionName === "promote-investigation-to-build" && investigationId) {
    void promoteInvestigationToBuild(investigationId);
  }
  if (actionName === "update-investigation-status" && investigationId && investigationStatus) {
    void updateInvestigation(investigationId, { status: investigationStatus });
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

document.addEventListener("focusout", () => {
  if (!state.pendingSoftRender) return;
  window.setTimeout(() => {
    if (isUserEditing()) return;
    state.pendingSoftRender = false;
    render();
  }, 0);
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

document.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const panelId = details.dataset.panelId;
    if (!panelId) return;
    if (details.open) state.expandedPanels.add(panelId);
    else state.expandedPanels.delete(panelId);
  },
  true,
);

void refreshData();
window.setInterval(updateLiveTimers, 500);
window.setInterval(() => {
  void refreshData({ soft: true });
}, 5000);

async function refreshData(options = {}) {
  if (state.refreshInFlight) return;
  const soft = Boolean(options.soft);
  state.refreshInFlight = true;
  if (!soft) {
    state.loading = true;
    state.error = undefined;
    render();
  }

  try {
    const [
      instance,
      groupProfile,
      runs,
      conversations,
      memories,
      memoryReviews,
      tools,
      toolPackageRunners,
      toolMigrations,
      toolSettings,
      buildRequests,
      investigations,
      secretHandles,
      toolServices,
      toolServiceLogs,
      toolServiceEvents,
      toolPromotions,
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
      fetchJson("/api/tool-package-runners").then((data) => data.runners ?? []),
      fetchJson("/api/tool-migrations").then((data) => data.migrations ?? []),
      fetchJson("/api/tool-settings").then((data) => data.settings ?? []),
      fetchJson("/api/tool-build-requests").then((data) => data.requests ?? []),
      fetchJson("/api/tool-investigations")
        .then((data) => data.investigations ?? [])
        .catch(() => []),
      fetchJson("/api/secret-handles").then((data) => data.secretHandles ?? []),
      fetchJson("/api/tool-services").then((data) => data.services ?? []),
      fetchJson("/api/tool-services/logs?limit=80").then((data) => data.logs ?? []),
      fetchJson("/api/tool-service-events?limit=80").then((data) => data.events ?? []),
      fetchJson("/api/tool-promotions").then((data) => data.promotions ?? []),
      fetchJson("/api/settings/model-tiers").then((data) => data.tiers ?? []),
      fetchJson("/api/model-providers").then((data) => data.providers ?? []),
      fetchJson("/api/models/catalog").catch(() => undefined),
      fetchJson("/api/users").then((data) => data.users ?? []),
      fetchJson("/api/audit-events").then((data) => data.events ?? []),
    ]);

    const nextData = {
      instance,
      groupProfile,
      runs,
      conversations,
      memories,
      memoryReviews,
      tools,
      toolPackageRunners,
      toolMigrations,
      toolSettings,
      buildRequests,
      investigations,
      secretHandles,
      toolServices,
      toolServiceLogs,
      toolServiceEvents,
      toolPromotions,
      tiers,
      modelProviders,
      modelCatalog,
      users,
      auditEvents,
      activeRunId: state.activeRunId ?? runs[0]?.id,
      loading: false,
    };
    const nextFingerprint = dataFingerprint(nextData);
    if (soft && nextFingerprint === state.dataFingerprint) {
      state.refreshInFlight = false;
      return;
    }
    Object.assign(state, nextData, {
      dataFingerprint: nextFingerprint,
    });
    syncActiveFromRoute();
    connectRunStream(activeRun()?.id);
    connectServiceLogStream();
  } catch (error) {
    if (soft) {
      state.refreshInFlight = false;
      return;
    }
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
  }

  state.refreshInFlight = false;
  if (soft && isUserEditingOrDrafting()) {
    state.pendingSoftRender = true;
    return;
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

function dataFingerprint(data) {
  return JSON.stringify({
    instance: data.instance,
    groupProfile: data.groupProfile,
    runs: data.runs,
    conversations: data.conversations,
    memories: data.memories,
    memoryReviews: data.memoryReviews,
    tools: data.tools,
    toolPackageRunners: data.toolPackageRunners,
    toolMigrations: data.toolMigrations,
    toolSettings: data.toolSettings,
    buildRequests: data.buildRequests,
    investigations: data.investigations,
    secretHandles: data.secretHandles,
    toolServices: data.toolServices,
    toolServiceLogs: data.toolServiceLogs,
    toolServiceEvents: data.toolServiceEvents,
    toolPromotions: data.toolPromotions,
    tiers: data.tiers,
    modelProviders: data.modelProviders,
    modelCatalog: data.modelCatalog,
    users: data.users,
    auditEvents: data.auditEvents,
  });
}

function isUserEditing() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
}

function isUserEditingOrDrafting() {
  if (isUserEditing()) return true;
  return [...state.expandedPanels].some((panelId) =>
    /^(tool-build-request|tool-rework:|span-tool-request:|build-rework:)/.test(panelId),
  );
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
    ${renderInvestigationModal()}
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
  const draft = matchingComposerDraft(continuing ? "continue" : "new", selectedThread?.id);
  const selectedRequester = draft?.requesterUserId ?? requester;
  const selectedChannel = draft?.channel ?? channel;
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
                          (user) =>
                            `<option value="${escapeHtml(user.id)}" ${user.id === selectedRequester ? "selected" : ""}>${escapeHtml(user.displayName)} · ${escapeHtml(user.id)}</option>`,
                        )
                        .join("")
                    : `<option value="user-admin">Admin · user-admin</option>`}
                </select>
              </label>
              <label>
                <span>Source</span>
                <select name="channel">
                  <option value="web" ${selectedChannel === "web" ? "selected" : ""}>Web console</option>
                  <option value="api" ${selectedChannel === "api" ? "selected" : ""}>API</option>
                </select>
              </label>
            </div>
          `}
        <textarea name="task" placeholder="Ask for research, code, screenshots, reports, reminders, or a correction to the selected thread." required>${escapeHtml(draft?.task ?? "")}</textarea>
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

function matchingComposerDraft(threadMode, threadId) {
  const draft = state.composerDraft;
  if (!draft || draft.threadMode !== threadMode) return undefined;
  if (threadMode === "continue" && draft.threadId !== threadId) return undefined;
  return draft;
}

function panelOpenAttr(panelId) {
  return state.expandedPanels.has(panelId) ? "open" : "";
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
  return `
    <div class="span-investigation-actions">
      <button
        type="button"
        class="ghost-button"
        data-action="open-investigation-modal"
        data-investigation-source="trace_span"
        data-span-id="${escapeHtml(node.spanId)}"
      >Create tool request / bug</button>
      <small class="status-note">Opens a Tool Investigation Ticket so the failure context is preserved before any rebuild.</small>
    </div>
  `;
}

function buildSpanInvestigationDraft(node) {
  const run = activeRun();
  const relatedTool = findToolForSpan(node);
  const activeVersion = relatedTool
    ? normalizeToolVersions(relatedTool).find((version) => version.active)?.version ?? relatedTool.version
    : "";
  const matchedToolName = relatedTool?.name ?? "";
  const titleParts = [node.title, relatedTool ? `(${relatedTool.displayName || relatedTool.name})` : ""].filter(Boolean);
  const title = titleParts.join(" ") || `Span ${node.spanId} needs investigation`;
  const inputSummary = node.parentTitle ? `Called by ${node.parentTitle}` : "Root coordinator span.";
  const outputSummary = node.detail ? truncate(node.detail, 1600) : undefined;
  const artifactRefs = artifactsFromPayload(node.payload).map((artifact) => ({
    id: artifact?.id,
    filename: artifact?.filename,
    mimeType: artifact?.mimeType,
    url: artifact?.url,
  }));
  const artifactQaSummary = node.payload?.artifactQa && typeof node.payload.artifactQa === "object"
    ? node.payload.artifactQa
    : undefined;
  const notes = [];
  if (!relatedTool) {
    notes.push(
      "No installed tool clearly matches this span actor/payload. The investigation is saved as `manual` so an operator can triage it before any rework.",
    );
  }
  return {
    source: "trace_span",
    title,
    matchedToolName,
    matchedToolVersion: activeVersion,
    runId: run?.id ?? "",
    spanId: node.spanId,
    artifactIds: artifactRefs.map((ref) => ref.id).filter(Boolean),
    contextBundle: {
      taskPrompt: run?.task,
      runTitle: run?.task,
      actor: node.actor,
      activity: node.activity,
      status: node.status,
      caller: node.parentTitle,
      inputSummary,
      outputSummary,
      error: node.status === "failed" ? truncate(node.detail ?? "", 1200) || node.title : undefined,
      artifactQa: artifactQaSummary,
      relatedArtifactRefs: artifactRefs,
      notes,
    },
    warnings: relatedTool
      ? []
      : [
          "Could not match this span to a registered tool by exact actor/payload. The investigation will be saved as a manual ticket. Triage and link it to the right tool/build request before rework.",
        ],
  };
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

function openInvestigationModalForSpan(spanId) {
  const run = activeRun();
  const events = run?.events ?? [];
  const node = events.length ? buildTraceNodes(events).find((entry) => entry.spanId === spanId) : undefined;
  if (!node) {
    state.notice = {
      title: "Span not found",
      body: "Could not load span context. Reopen the run in Trace Lab and try again.",
    };
    render();
    return;
  }
  state.investigationModal = buildSpanInvestigationDraft(node);
  state.investigationModalNotice = undefined;
  render();
}

function closeInvestigationModal() {
  state.investigationModal = undefined;
  state.investigationModalNotice = undefined;
  render();
}

function renderInvestigationModal() {
  const draft = state.investigationModal;
  if (!draft) return "";
  const notice = state.investigationModalNotice;
  const noticeBlock = notice
    ? `<div class="investigation-modal-notice ${escapeHtml(notice.kind ?? "info")}">
         <strong>${escapeHtml(notice.title ?? "Investigation")}</strong>
         <span>${escapeHtml(notice.body ?? "")}</span>
         ${notice.investigationId
            ? `<small>Ticket id: <code>${escapeHtml(notice.investigationId)}</code></small>`
            : ""}
       </div>`
    : "";
  const warnings = (draft.warnings ?? []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const matchedTool = draft.matchedToolName
    ? `<div><dt>Matched tool</dt><dd><code>${escapeHtml(draft.matchedToolName)}</code>${draft.matchedToolVersion ? ` v${escapeHtml(draft.matchedToolVersion)}` : ""}</dd></div>`
    : `<div><dt>Matched tool</dt><dd class="muted">none — manual investigation</dd></div>`;
  const contextRows = renderInvestigationContextPreview(draft.contextBundle);
  const artifactRefRows = (draft.contextBundle.relatedArtifactRefs ?? [])
    .map((ref) => `<li><strong>${escapeHtml(ref.filename ?? ref.id ?? "artifact")}</strong> <small>${escapeHtml(ref.mimeType ?? "")}</small></li>`)
    .join("");
  return `
    <div class="investigation-modal-overlay" data-action="close-investigation-modal">
      <div class="investigation-modal" role="dialog" aria-modal="true" aria-labelledby="investigation-modal-title" data-action="stop-propagation">
        <header class="investigation-modal-header">
          <div>
            <span class="eyebrow">Tool Investigation Ticket</span>
            <h2 id="investigation-modal-title">${escapeHtml(draft.title)}</h2>
            <p class="muted">A durable ticket preserves the failure context. Promote it to a Tool Build / rework after triage.</p>
          </div>
          <button type="button" class="ghost-button" data-action="close-investigation-modal">Close</button>
        </header>
        ${warnings ? `<section class="investigation-modal-warnings"><strong>Heads up</strong><ul>${warnings}</ul></section>` : ""}
        ${noticeBlock}
        <section class="investigation-modal-context">
          <h3>Context that will be attached</h3>
          <dl class="investigation-context-grid">
            <div><dt>Source</dt><dd>${escapeHtml(draft.source)}</dd></div>
            <div><dt>Run</dt><dd>${escapeHtml(draft.runId || "—")}</dd></div>
            <div><dt>Span</dt><dd>${escapeHtml(draft.spanId || "—")}</dd></div>
            ${matchedTool}
            ${contextRows}
          </dl>
          ${artifactRefRows ? `<details><summary>Related artifacts (${(draft.contextBundle.relatedArtifactRefs ?? []).length})</summary><ul>${artifactRefRows}</ul></details>` : ""}
          <small class="muted">Sensitive keys (secret, token, password, apiKey, credential, authorization) are redacted server-side before storage.</small>
        </section>
        <form data-action="create-investigation" class="investigation-modal-form">
          <input type="hidden" name="source" value="${escapeHtml(draft.source)}" />
          <input type="hidden" name="title" value="${escapeHtml(draft.title)}" />
          <input type="hidden" name="runId" value="${escapeHtml(draft.runId)}" />
          <input type="hidden" name="spanId" value="${escapeHtml(draft.spanId)}" />
          <input type="hidden" name="toolName" value="${escapeHtml(draft.matchedToolName)}" />
          <input type="hidden" name="toolVersion" value="${escapeHtml(draft.matchedToolVersion ?? "")}" />
          <input type="hidden" name="artifactIds" value="${escapeHtml((draft.artifactIds ?? []).join(","))}" />
          <input type="hidden" name="contextBundle" value="${escapeHtml(JSON.stringify(draft.contextBundle))}" />
          <label>
            <span>Operator comment</span>
            <textarea name="operatorComment" rows="4" placeholder="Why this needs investigation, what was expected, what to verify before rebuilding the tool."></textarea>
          </label>
          <div class="investigation-modal-actions">
            <button type="button" class="ghost-button" data-action="close-investigation-modal">Cancel</button>
            <button type="submit" class="primary-button">Create investigation</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderInvestigationContextPreview(bundle) {
  if (!bundle) return "";
  const rows = [];
  if (bundle.actor) rows.push(`<div><dt>Actor</dt><dd>${escapeHtml(bundle.actor)}</dd></div>`);
  if (bundle.activity) rows.push(`<div><dt>Activity</dt><dd>${escapeHtml(bundle.activity)}</dd></div>`);
  if (bundle.status) rows.push(`<div><dt>Status</dt><dd>${escapeHtml(bundle.status)}</dd></div>`);
  if (bundle.caller) rows.push(`<div><dt>Caller</dt><dd>${escapeHtml(bundle.caller)}</dd></div>`);
  if (bundle.taskPrompt) rows.push(`<div><dt>Task prompt</dt><dd>${escapeHtml(truncate(bundle.taskPrompt, 200))}</dd></div>`);
  if (bundle.inputSummary) rows.push(`<div><dt>Input summary</dt><dd>${escapeHtml(truncate(bundle.inputSummary, 240))}</dd></div>`);
  if (bundle.outputSummary) rows.push(`<div><dt>Output summary</dt><dd>${escapeHtml(truncate(bundle.outputSummary, 320))}</dd></div>`);
  if (bundle.error) rows.push(`<div><dt>Error</dt><dd>${escapeHtml(truncate(bundle.error, 320))}</dd></div>`);
  if (bundle.artifactQa) rows.push(`<div><dt>Artifact QA</dt><dd><code>${escapeHtml(JSON.stringify(bundle.artifactQa).slice(0, 240))}</code></dd></div>`);
  return rows.join("");
}

async function createInvestigation(form) {
  const formData = new FormData(form);
  const artifactIdsRaw = String(formData.get("artifactIds") ?? "");
  const artifactIds = artifactIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  let contextBundle;
  try {
    contextBundle = JSON.parse(String(formData.get("contextBundle") ?? "{}"));
  } catch {
    contextBundle = {};
  }
  const payload = {
    source: String(formData.get("source") ?? "manual"),
    title: String(formData.get("title") ?? "").trim() || "Untitled investigation",
    operatorComment: String(formData.get("operatorComment") ?? "").trim() || undefined,
    runId: String(formData.get("runId") ?? "").trim() || undefined,
    spanId: String(formData.get("spanId") ?? "").trim() || undefined,
    toolName: String(formData.get("toolName") ?? "").trim() || undefined,
    toolVersion: String(formData.get("toolVersion") ?? "").trim() || undefined,
    artifactIds,
    contextBundle,
  };
  setComposerBusy(form, true);
  try {
    const data = await fetchJson("/api/tool-investigations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.investigations = [data.investigation, ...state.investigations.filter((item) => item.id !== data.investigation.id)];
    state.investigationModalNotice = {
      kind: "success",
      title: "Investigation created",
      body: "Open Tool Builds to triage and promote it to a build/rework request when ready.",
      investigationId: data.investigation.id,
    };
    render();
  } catch (error) {
    state.investigationModalNotice = {
      kind: "error",
      title: "Could not create investigation",
      body: error instanceof Error ? error.message : String(error),
    };
    render();
  } finally {
    setComposerBusy(form, false);
  }
}

async function updateInvestigation(id, update) {
  try {
    const data = await fetchJson(`/api/tool-investigations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    state.investigations = state.investigations.map((item) => (item.id === id ? data.investigation : item));
    render();
    return data.investigation;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
    return undefined;
  }
}

async function promoteInvestigationToBuild(id) {
  const investigation = state.investigations.find((item) => item.id === id);
  if (!investigation) return;
  const run = activeRun();
  const reasonLines = [
    `Promoted from Tool Investigation ${investigation.id}.`,
    investigation.title ? `Title: ${investigation.title}` : "",
    investigation.operatorComment ? `Operator comment: ${investigation.operatorComment}` : "",
    investigation.contextBundle?.taskPrompt ? `Task: ${investigation.contextBundle.taskPrompt}` : "",
    investigation.contextBundle?.error ? `Observed error: ${investigation.contextBundle.error}` : "",
    investigation.contextBundle?.outputSummary ? `Observed output: ${investigation.contextBundle.outputSummary}` : "",
  ].filter(Boolean);
  const reason = reasonLines.join("\n");
  const tool = investigation.toolName ? state.tools.find((item) => item.name === investigation.toolName) : undefined;
  const buildPayload = {
    displayName: tool?.displayName || investigation.toolName || investigation.title,
    reason,
    sourceRunId: investigation.runId || run?.id || undefined,
    sourceSpanId: investigation.spanId || undefined,
    taskSummary: investigation.contextBundle?.taskPrompt || undefined,
    desiredToolName: investigation.toolName || undefined,
    replacesToolName: investigation.toolName || undefined,
    replacesVersion: investigation.toolVersion || undefined,
    startupMode: tool?.startupMode || undefined,
    feedback: investigation.operatorComment || undefined,
  };
  try {
    const data = await fetchJson("/api/tool-build-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload),
    });
    state.buildRequests = [data.request, ...state.buildRequests.filter((item) => item.id !== data.request.id)];
    const updated = await updateInvestigation(id, {
      status: "linked_to_build",
      linkedBuildRequestId: data.request.id,
    });
    state.notice = {
      title: "Investigation linked to Tool Build",
      body: `${data.request.capability} is now in the Tool Builds queue (${data.request.id}).`,
      route: "tool-builds",
      actionLabel: "Open queue",
    };
    render();
    return updated;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
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
  const limitations = state.memories.filter(isExternalBlockerMemory);
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
            ${miniInsight("Known limitations", String(limitations.length))}
            ${miniInsight("Rejected", String(rejected.length))}
            ${miniInsight("Archived", String(archived.length))}
          </div>
        </section>
        <div class="tabs-row memory-tabs">
          ${renderMemoryFilterTab("all", "All Memory", state.memories.length)}
          ${renderMemoryFilterTab("proposed", "Review Queue", reviewQueue.length)}
          ${renderMemoryFilterTab("accepted", "Accepted", accepted.length)}
          ${renderMemoryFilterTab("limitations", "Known Limitations", limitations.length)}
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
  const isLimitation = isExternalBlockerMemory(memory);
  const retrievalImpact =
    isLimitation
      ? "known external limitation"
      : status === "accepted"
      ? "available to matching runs"
      : status === "proposed"
        ? "waiting for review"
        : "excluded from retrieval";
  return `
    <article class="knowledge-card ${isLimitation ? "limitation-memory" : ""} ${state.selectedMemoryId === memory.id ? "selected" : ""}" data-action="select-memory" data-memory-id="${memory.id}" tabindex="0">
      <div class="card-topline">
        <span>${escapeHtml(formatMemoryScope(memory))}</span>
        <span>${formatRelative(memory.createdAt)}</span>
      </div>
      <h3>${escapeHtml(memory.title)}</h3>
      <p>${escapeHtml(memory.summary)}</p>
      <div class="tag-row">
        ${isLimitation ? `<span class="warning-chip">external blocker</span>` : ""}
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
      ${isExternalBlockerMemory(memory) ? contextBlock("Known limitation", "The agent should try another public evidence strategy first. If no useful public source is available, it should explain the external blocker instead of asking to rebuild the tool.") : ""}
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
  if (state.memoryFilter === "limitations") return memories.filter(isExternalBlockerMemory);
  return memories.filter((memory) => normalizeMemoryStatus(memory.status) === state.memoryFilter);
}

function isExternalBlockerMemory(memory) {
  return (memory.tags ?? []).includes("external-blocker");
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
        <details class="surface-panel collapsible-panel" data-panel-id="tool-package-import" ${panelOpenAttr("tool-package-import")}>
          <summary>Import portable tool package manifest</summary>
          <form data-action="import-tool-package" class="settings-form">
            <label>
              Manifest JSON
              <textarea name="manifest" rows="8" placeholder='{"schemaVersion":"agentic.tool-package.v1","name":"generated.example.tool","version":"1.0.0","description":"Reusable capability package.","capabilities":["example-capability"],"startupMode":"on-demand","package":{"type":"external-package","ref":"npm:@scope/tool@1.0.0"}}'></textarea>
            </label>
            <p class="context-note">Imports contract metadata only. Non-local packages stay disabled until a runner can execute that package reference.</p>
            <button type="submit" class="ghost-button">Import package</button>
          </form>
        </details>
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
    tool.promotionEvidence?.summary,
    tool.promotionEvidence?.buildRequestId,
    tool.promotionEvidence?.packageRef,
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
      version.changeSummary,
      version.promotionEvidence?.summary,
      version.promotionEvidence?.buildRequestId,
      version.promotionEvidence?.packageRef,
    ]),
    ...promotionJournalForTool(tool.name).flatMap((promotion) => [
      promotion.summary,
      promotion.buildRequestId,
      promotion.packageRef,
      promotion.toolVersion,
      ...(promotion.migrationIds ?? []),
    ]),
  ];
  return haystack.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function renderToolCard(tool) {
  const label = tool.displayName || tool.name;
  const isGenerated = tool.source === "generated";
  const service = serviceForTool(tool.name);
  const serviceStatus = service ? service.status : undefined;
  return `
    <article class="tool-card ${state.selectedToolName === tool.name ? "selected" : ""}" data-action="select-tool" data-tool-name="${tool.name}" tabindex="0">
      <div class="card-topline">
        <span>${tool.source ?? "builtin"}</span>
        <span>${tool.status ?? "available"}</span>
      </div>
      ${service ? `
        <div class="tool-runtime-strip ${escapeHtml(serviceStatus)}">
          <span class="status-pill ${escapeHtml(serviceStatus)}">${escapeHtml(serviceStatus)}</span>
          <strong>${escapeHtml(service.desiredState === "running" ? "Always-on active" : "Always-on stopped")}</strong>
          <small>${escapeHtml(service.lastHeartbeatAt ? formatRelative(service.lastHeartbeatAt) : "no heartbeat")}</small>
        </div>
      ` : ""}
      <h3>${escapeHtml(label)} <small>v${escapeHtml(tool.version)}</small></h3>
      <small class="status-note">System name: ${escapeHtml(tool.name)}</small>
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
      ${renderToolRuntimeSettings(tool)}
      ${contextBlock("Storage", formatToolStorage(tool))}
      ${contextBlock("Migrations", formatToolMigrations(tool))}
      ${contextBlock("Promotion evidence", formatToolPromotionEvidence(tool.promotionEvidence))}
      ${renderToolPromotionJournal(tool)}
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
        <span>${escapeHtml(`${service.consecutiveFailureCount ?? 0} failures`)}</span>
        ${service.pendingRestartApproval ? `<span class="status-pill blocked">restart approval</span>` : ""}
        ${service.nextRestartAt ? `<span>${escapeHtml(`restart ${formatFutureRelative(service.nextRestartAt)}`)}</span>` : ""}
      </div>
      ${service.lastRestartAt ? `<small class="status-note">Last restart ${escapeHtml(formatRelative(service.lastRestartAt))}${service.lastRestartReason ? ` · ${escapeHtml(service.lastRestartReason)}` : ""}</small>` : ""}
      <p>${escapeHtml(service.detail || "No service detail.")}</p>
      ${renderServiceRestartPolicyForm(service)}
      <div class="action-row compact">
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="start">Start</button>
        <button type="button" class="ghost-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="restart">Restart</button>
        <button type="button" class="ghost-button danger-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="stop">Stop</button>
      </div>
    </section>
  `;
}

function renderServiceRestartPolicyForm(service) {
  const autoRestartEnabled = service.autoRestartEnabled ?? true;
  const maxAutoRestarts = service.maxAutoRestarts ?? 3;
  const restartBackoffMs = service.restartBackoffMs ?? 0;
  const restartBackoffMultiplier = service.restartBackoffMultiplier ?? 1;
  const restartBackoffMaxMs = service.restartBackoffMaxMs ?? 0;
  const restartBackoffJitterRatio = service.restartBackoffJitterRatio ?? 0;
  const restartRequiresApproval = Boolean(service.restartRequiresApproval);
  const policyParts = [
    autoRestartEnabled ? "auto" : "manual",
    `max ${maxAutoRestarts}`,
    restartBackoffMs > 0 ? `backoff ${formatDuration(restartBackoffMs)} ×${restartBackoffMultiplier}` : "no backoff",
    restartBackoffMaxMs > 0 ? `cap ${formatDuration(restartBackoffMaxMs)}` : "no cap",
    restartBackoffJitterRatio > 0 ? `jitter ${Math.round(restartBackoffJitterRatio * 100)}%` : "no jitter",
    restartRequiresApproval ? "approval" : "no approval",
  ];
  return `
    <details class="service-policy-editor">
      <summary>Restart policy: ${escapeHtml(policyParts.join(" · "))}</summary>
      <form data-action="update-tool-service-policy" class="inline-edit-form">
        <input type="hidden" name="toolName" value="${escapeHtml(service.toolName)}" />
        <label class="checkbox-line">
          <input type="checkbox" name="autoRestartEnabled" ${autoRestartEnabled ? "checked" : ""} />
          Auto-restart after failed heartbeat
        </label>
        <label class="checkbox-line">
          <input type="checkbox" name="restartRequiresApproval" ${restartRequiresApproval ? "checked" : ""} />
          Require operator approval before auto-restart
        </label>
        <label>
          Max auto restarts
          <input type="number" name="maxAutoRestarts" min="0" step="1" value="${escapeHtml(String(maxAutoRestarts))}" />
        </label>
        <label>
          Restart backoff, ms
          <input type="number" name="restartBackoffMs" min="0" step="1000" value="${escapeHtml(String(restartBackoffMs))}" />
        </label>
        <label>
          Backoff multiplier
          <input type="number" name="restartBackoffMultiplier" min="1" step="0.1" value="${escapeHtml(String(restartBackoffMultiplier))}" />
        </label>
        <label>
          Backoff cap, ms
          <input type="number" name="restartBackoffMaxMs" min="0" step="1000" value="${escapeHtml(String(restartBackoffMaxMs))}" />
        </label>
        <label>
          Backoff jitter ratio
          <input type="number" name="restartBackoffJitterRatio" min="0" max="1" step="0.05" value="${escapeHtml(String(restartBackoffJitterRatio))}" />
        </label>
        <button type="submit" class="ghost-button">Save policy</button>
      </form>
    </details>
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
            const promotion = version.promotionEvidence ? formatToolPromotionEvidence(version.promotionEvidence) : "";
            return `
              <article class="version-history-card ${version.active ? "active" : ""}">
                <div class="version-history-header">
                  <strong>v${escapeHtml(version.version)}</strong>
                  <span>${version.active ? "active" : escapeHtml(version.status ?? "available")}</span>
                </div>
                <p>${escapeHtml(version.changeSummary || version.description || "No changelog recorded for this version.")}</p>
                <small>${escapeHtml(telemetry)}</small>
                <small>${escapeHtml(version.modulePath || "No module path")}${version.testPath ? ` · ${escapeHtml(version.testPath)}` : ""}</small>
                ${promotion ? `<small class="promotion-evidence">${escapeHtml(promotion)}</small>` : ""}
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

function renderToolRuntimeSettings(tool) {
  const settings = toolSettingsFor(tool.name);
  const configured = new Map(settings.map((setting) => [setting.key, setting]));
  const schemaKeys = Object.keys(tool.settingsSchema?.properties ?? {});
  const requiredKeys = tool.requiredConfigurationKeys ?? [];
  const keys = uniqueStrings([
    ...requiredKeys,
    ...schemaKeys,
    ...settings.map((setting) => setting.key),
  ]);
  const secrets = tool.requiredSecretHandles ?? [];
  const configuredRequiredCount = requiredKeys.filter((key) => configured.has(key)).length;
  const missingRequiredCount = Math.max(0, requiredKeys.length - configuredRequiredCount);
  return `
    <section class="context-block tool-settings-block">
      <h4>Runtime settings</h4>
      <p class="context-note">Non-secret values used by this tool at runtime. Put API keys, bot tokens, and passwords into Secret Handles instead.</p>
      <div class="tool-settings-summary">
        <span>${configured.size} saved setting${configured.size === 1 ? "" : "s"}</span>
        <span class="${missingRequiredCount ? "warn" : "ok"}">${missingRequiredCount ? `${missingRequiredCount} required missing` : "required config ready"}</span>
        <span>${secrets.length} secret handle${secrets.length === 1 ? "" : "s"} declared</span>
      </div>
      <form data-action="save-tool-settings" class="tool-settings-form">
        <input type="hidden" name="toolName" value="${escapeHtml(tool.name)}" />
        <div class="settings-form-section">
          <strong>Configuration values</strong>
        ${keys.length
          ? keys.map((key) => {
              const setting = configured.get(key);
              const required = requiredKeys.includes(key);
              const schemaHint = settingSchemaHint(tool.settingsSchema, key);
              return `
                <label>
                  <span>${escapeHtml(key)}${required ? " *" : ""}${setting ? ` · ${escapeHtml(formatRelative(setting.updatedAt))}` : ""}</span>
                  ${renderRuntimeSettingInput(tool.settingsSchema, key, setting?.value ?? "", schemaHint)}
                  <small>${required ? "Required by tool contract." : "Optional override. Leave blank to remove a saved value."}</small>
                </label>
              `;
            }).join("")
          : `<p class="context-note">This tool does not declare required configuration keys yet. Add an optional key below if the runtime needs one.</p>`}
        </div>
        <div class="inline-form two-column-form">
          <label>
            Optional key
            <input name="customKey" placeholder="PROVIDER_BASE_URL" />
          </label>
          <label>
            Optional value
            <input name="customValue" placeholder="https://api.example.com" />
          </label>
        </div>
        <button type="submit" class="ghost-button">Save runtime settings</button>
      </form>
      <div class="settings-form-section">
        <strong>Secret handles</strong>
        <div class="secret-handle-strip">
          ${secrets.length
            ? secrets.map((handle) => {
                const secret = state.secretHandles.find((item) => item.handle === handle);
                return `<span class="${secret ? "available" : "missing"}">${escapeHtml(handle)}${secret ? ` · ${escapeHtml(secret.provider)}` : " · missing"}</span>`;
              }).join("")
            : "<span>No required secret handles</span>"}
        </div>
      </div>
      ${renderToolSettingsSchema(tool.settingsSchema)}
    </section>
  `;
}

function toolSettingsFor(toolName) {
  return (state.toolSettings ?? []).filter((setting) => setting.toolName === toolName);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort((a, b) => a.localeCompare(b));
}

function settingSchemaHint(schema, key) {
  const property = schema?.properties?.[key];
  if (!property || typeof property !== "object") return "";
  return property.description || property.default || property.format || property.type || "";
}

function renderRuntimeSettingInput(schema, key, value, placeholder) {
  const property = schema?.properties?.[key];
  const shape = property && typeof property === "object" ? property : {};
  const name = `setting:${key}`;
  const enumValues = Array.isArray(shape.enum) ? shape.enum.map(String) : [];
  if (enumValues.length) {
    return `
      <select name="${escapeHtml(name)}">
        <option value="">Not configured</option>
        ${enumValues.map((item) => `<option value="${escapeHtml(item)}" ${String(value) === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
      </select>
    `;
  }
  if (shape.type === "boolean") {
    return `
      <select name="${escapeHtml(name)}">
        <option value="">Not configured</option>
        <option value="true" ${String(value).toLowerCase() === "true" ? "selected" : ""}>true</option>
        <option value="false" ${String(value).toLowerCase() === "false" ? "selected" : ""}>false</option>
      </select>
    `;
  }
  if (shape.type === "number" || shape.type === "integer") {
    const step = shape.type === "integer" ? "1" : "any";
    const min = typeof shape.minimum === "number" ? ` min="${escapeHtml(String(shape.minimum))}"` : "";
    const max = typeof shape.maximum === "number" ? ` max="${escapeHtml(String(shape.maximum))}"` : "";
    return `<input type="number" step="${step}"${min}${max} name="${escapeHtml(name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder || "Runtime value")}" />`;
  }
  const inputType = shape.format === "uri" || shape.format === "url" ? "url" : "text";
  return `<input type="${inputType}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder || "Runtime value")}" />`;
}

function renderToolSettingsSchema(schema) {
  const properties = Object.entries(schema?.properties ?? {});
  if (!properties.length) return "";
  return `
    <details class="settings-schema-preview">
      <summary>Declared settings schema</summary>
      <div class="settings-schema-list">
        ${properties.map(([key, property]) => {
          const shape = typeof property === "object" && property ? property : {};
          return `
            <div>
              <strong>${escapeHtml(key)}</strong>
              <span>${escapeHtml([shape.type, shape.format].filter(Boolean).join(" · ") || "value")}</span>
              ${shape.description ? `<p>${escapeHtml(shape.description)}</p>` : ""}
            </div>
          `;
        }).join("")}
      </div>
    </details>
  `;
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

function formatToolPromotionEvidence(evidence) {
  if (!evidence) return "No promotion evidence recorded yet.";
  const qa = evidence.qaReport ?? {};
  const checks = Array.isArray(qa.checks) ? qa.checks : [];
  const reviews = Array.isArray(qa.reviews) ? qa.reviews : [];
  return [
    evidence.status ? `Status: ${evidence.status}` : undefined,
    evidence.promotedAt ? `Promoted: ${formatRelative(evidence.promotedAt)}` : undefined,
    evidence.summary ? `Summary: ${evidence.summary}` : undefined,
    evidence.buildRequestId ? `Build request: ${evidence.buildRequestId}` : undefined,
    evidence.packageRef ? `Package: ${evidence.packageRef}` : undefined,
    evidence.migrationIds?.length ? `Migrations: ${evidence.migrationIds.join(", ")}` : undefined,
    qa.summary ? `QA: ${qa.summary}` : undefined,
    checks.length ? `Checks: ${checks.join("; ")}` : undefined,
    reviews.length ? `Reviews: ${reviews.map((review) => `${review.kind ?? "review"} ${review.decision ?? ""}`).join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function promotionJournalForTool(toolName) {
  return (state.toolPromotions ?? [])
    .filter((promotion) => promotion.toolName === toolName)
    .sort((a, b) => String(b.promotedAt ?? "").localeCompare(String(a.promotedAt ?? "")));
}

function renderToolPromotionJournal(tool) {
  if (tool.source !== "generated") return "";
  const promotions = promotionJournalForTool(tool.name);
  return `
    <section class="context-block promotion-journal-block">
      <h4>Promotion journal</h4>
      ${promotions.length
        ? `
          <div class="promotion-journal-list">
            ${promotions.slice(0, 6).map(renderPromotionJournalEntry).join("")}
          </div>
        `
        : `<p>No promotion journal entries yet. Future generated versions will append registrar decisions here.</p>`}
    </section>
  `;
}

function renderPromotionJournalEntry(promotion) {
  const qa = promotion.qaReport ?? {};
  const checks = Array.isArray(qa.checks) ? qa.checks : [];
  return `
    <article class="promotion-journal-entry">
      <div class="version-history-header">
        <strong>v${escapeHtml(promotion.toolVersion ?? "unknown")}</strong>
        <span>${escapeHtml(promotion.status ?? "promoted")}</span>
      </div>
      <p>${escapeHtml(promotion.summary || qa.summary || "No promotion summary recorded.")}</p>
      <small>${escapeHtml(promotion.promotedAt ? `Promoted ${formatRelative(promotion.promotedAt)}` : "No promotion time")}</small>
      ${promotion.buildRequestId ? `<small>Build request: ${escapeHtml(promotion.buildRequestId)}</small>` : ""}
      ${promotion.packageRef ? `<small>Package: ${escapeHtml(promotion.packageRef)}</small>` : ""}
      ${promotion.migrationIds?.length ? `<small>Migrations: ${escapeHtml(promotion.migrationIds.join(", "))}</small>` : ""}
      ${checks.length ? `<small class="promotion-evidence">Checks: ${escapeHtml(checks.slice(0, 4).join("; "))}</small>` : ""}
    </article>
  `;
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
    <details class="rework-box tool-rework-box" data-panel-id="tool-rework:${escapeHtml(tool.name)}" ${panelOpenAttr(`tool-rework:${tool.name}`)}>
      <summary>Request change / new version</summary>
      <form data-action="rework-tool" class="rework-form">
        <input type="hidden" name="toolName" value="${escapeHtml(tool.name)}" />
        <input type="hidden" name="displayName" value="${escapeHtml(tool.displayName || tool.name)}" />
        <input type="hidden" name="capability" value="${escapeHtml((tool.capabilities ?? [tool.name])[0] ?? tool.name)}" />
        <input type="hidden" name="replacesVersion" value="${escapeHtml(activeVersion)}" />
        <input type="hidden" name="startupMode" value="${escapeHtml(tool.startupMode ?? "on-demand")}" />
        <label>
          <span>Change request</span>
          <textarea name="feedback" placeholder="${escapeHtml(defaultFeedback)}" required></textarea>
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
      <details class="surface-panel tool-build-request-panel expandable-panel" data-panel-id="tool-build-request" ${panelOpenAttr("tool-build-request")}>
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
            <textarea name="qaCriteria" rows="5" placeholder="${escapeHtml(defaultQaCriteria)}"></textarea>
            <small>You can add extra acceptance checks here before creating the request.</small>
          </label>
          <div class="composer-bottom">
            <p class="composer-hint">Created tools must be TypeScript modules with docs, tests, healthchecks, and registry metadata.</p>
            <button type="submit" class="primary-button">Create Build Request</button>
          </div>
        </form>
      </details>
      ${renderToolInvestigationsSection()}
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

function renderToolInvestigationsSection() {
  const investigations = state.investigations ?? [];
  const open = investigations.filter((item) => item.status !== "closed" && item.status !== "linked_to_build");
  const linked = investigations.filter((item) => item.status === "linked_to_build");
  return `
    <section class="surface-panel investigations-panel" data-panel-id="tool-investigations">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Reviewable failure context</span>
          <h2>Tool Investigations</h2>
          <p>Investigations are durable tickets created from Trace Lab when a tool/span/artifact fails. They preserve context before any rebuild so the right tool can be improved instead of patched blindly.</p>
        </div>
        <span class="context-chip">${open.length} open · ${linked.length} linked</span>
      </div>
      ${investigations.length
        ? `<div class="investigation-grid">${investigations.map(renderInvestigationCard).join("")}</div>`
        : `<p class="muted">No investigations yet. Open Trace Lab, select a span, and click <em>Create tool request / bug</em>.</p>`}
    </section>
  `;
}

function renderInvestigationCard(investigation) {
  const tool = investigation.toolName ? state.tools.find((item) => item.name === investigation.toolName) : undefined;
  const canPromote = investigation.status === "open" || investigation.status === "triaged";
  return `
    <article class="investigation-card" data-investigation-id="${escapeHtml(investigation.id)}">
      <div class="card-topline">
        <span>${escapeHtml(formatStatusLabel(investigation.status))}</span>
        <span>${formatRelative(investigation.updatedAt ?? investigation.createdAt)}</span>
      </div>
      <strong>${escapeHtml(investigation.title)}</strong>
      <small class="status-note">Source: ${escapeHtml(investigation.source)}</small>
      ${investigation.toolName
        ? `<small class="status-note">Tool: <code>${escapeHtml(investigation.toolName)}</code>${investigation.toolVersion ? ` v${escapeHtml(investigation.toolVersion)}` : ""}${tool ? "" : " <em>(not currently registered)</em>"}</small>`
        : `<small class="status-note muted">Tool: not matched (manual ticket)</small>`}
      ${investigation.runId ? `<small class="status-note">Run: <code>${escapeHtml(investigation.runId)}</code></small>` : ""}
      ${investigation.spanId ? `<small class="status-note">Span: <code>${escapeHtml(investigation.spanId)}</code></small>` : ""}
      ${investigation.linkedBuildRequestId
        ? `<small class="status-note">Linked build: <code>${escapeHtml(investigation.linkedBuildRequestId)}</code></small>`
        : ""}
      ${investigation.operatorComment
        ? `<p class="investigation-comment">${escapeHtml(truncate(investigation.operatorComment, 360))}</p>`
        : ""}
      <div class="card-actions">
        ${canPromote
          ? `<button type="button" class="ghost-button" data-action="promote-investigation-to-build" data-investigation-id="${escapeHtml(investigation.id)}">Promote to Tool Build request</button>`
          : ""}
        ${investigation.status === "open"
          ? `<button type="button" class="ghost-button" data-action="update-investigation-status" data-investigation-id="${escapeHtml(investigation.id)}" data-investigation-status="triaged">Mark triaged</button>`
          : ""}
        ${investigation.status !== "closed"
          ? `<button type="button" class="ghost-button" data-action="update-investigation-status" data-investigation-id="${escapeHtml(investigation.id)}" data-investigation-status="closed">Close</button>`
          : ""}
        ${investigation.runId
          ? `<button type="button" class="ghost-button" data-action="open-trace" data-run-id="${escapeHtml(investigation.runId)}">Open in Trace Lab</button>`
          : ""}
      </div>
    </article>
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
      ${renderToolBuildQaEvidence(request.qaReport)}
      ${renderToolBuildReviews(request.qaReport?.reviews)}
      <details class="build-preview" data-panel-id="build-preview:${escapeHtml(request.id)}" ${panelOpenAttr(`build-preview:${request.id}`)}>
        <summary>Preview</summary>
        ${contextBlock("Tool contract", `${request.contract?.toolName ?? "pending"}\n${request.contract?.modulePath ?? "module pending"}\n${request.contract?.testPath ?? "test pending"}`)}
        ${contextBlock("Run mode", request.contract?.startupMode ?? "on-demand")}
        ${contextBlock("QA criteria", (request.contract?.qaCriteria ?? request.qaCriteria ?? []).join("\n") || "No QA criteria.")}
        ${request.qaReport ? contextBlock("QA and activation checks", (request.qaReport.checks ?? []).join("\n") || "No checks recorded.") : ""}
      </details>
      <div class="card-actions">
        ${["requested", "qa_failed", "blocked"].includes(request.status)
          ? `<button type="button" class="ghost-button" data-action="run-tool-build" data-build-id="${request.id}">Run builder</button>`
          : ""}
        <button type="button" class="ghost-button" data-action="stop-tool-build" data-build-id="${request.id}">Stop</button>
        <button type="button" class="ghost-button danger-button" data-action="delete-tool-build" data-build-id="${request.id}">Delete</button>
      </div>
      <details class="rework-box" data-panel-id="build-rework:${escapeHtml(request.id)}" ${panelOpenAttr(`build-rework:${request.id}`)}>
        <summary>Create revision request</summary>
        <form data-action="rework-tool-build" class="rework-form">
          <input type="hidden" name="buildId" value="${escapeHtml(request.id)}" />
          <textarea name="feedback" placeholder="${escapeHtml(suggestToolBuildReworkPlaceholder(request))}" required></textarea>
          <button type="submit" class="ghost-button">Create rework request</button>
        </form>
      </details>
    </article>
  `;
}

function suggestToolBuildReworkPlaceholder(request) {
  const activationChecks = Array.isArray(request.qaReport?.checks)
    ? request.qaReport.checks.filter((check) => /^activation fail:/i.test(String(check)))
    : [];
  if (activationChecks.length > 0) {
    return [
      "Describe the runtime activation fix you want.",
      `Current blocker: ${request.statusDetail || request.qaReport?.summary || activationChecks[0]}`,
      `Evidence: ${activationChecks.join("; ")}`,
      "Expected result: rebuild a new version, pass QA, activate runtime successfully, and keep the old version available for rollback.",
    ].join("\n");
  }

  if (request.statusDetail || request.qaReport?.summary) {
    return [
      "Describe what should be changed, fixed, retested, or redesigned.",
      request.statusDetail ? `Current status: ${request.statusDetail}` : undefined,
      request.qaReport?.summary ? `QA summary: ${request.qaReport.summary}` : undefined,
      "Expected result: create a new version, pass QA, and promote only after activation succeeds.",
    ].filter(Boolean).join("\n");
  }

  return "What should be changed, fixed, retested, or redesigned?";
}

function renderToolBuildQaEvidence(qaReport) {
  if (!qaReport || !Array.isArray(qaReport.checks) || qaReport.checks.length === 0) return "";
  const activationChecks = qaReport.checks.filter((check) => /^activation (pass|fail|rollback pass|rollback fail):/i.test(String(check)));
  if (activationChecks.length === 0) return "";

  return `
    <div class="qa-evidence-list">
      ${activationChecks
        .map((check) => `<small class="status-note">${escapeHtml(check)}</small>`)
        .join("")}
    </div>
  `;
}

function renderToolBuildReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return "";
  return `
    <div class="build-review-list">
      ${reviews
        .map(
          (review) => `
            <small class="status-note">
              ${escapeHtml(review.kind ?? "review")} review:
              <strong>${escapeHtml(review.decision ?? "unknown")}</strong>
              ${escapeHtml(review.summary ?? "")}
            </small>
          `,
        )
        .join("")}
    </div>
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
      <section class="surface-panel helper-panel">
        <div>
          <span class="eyebrow">Access model</span>
          <h2>How to add a person</h2>
          <p>Create a user here, then add one or more channel identities. For this Telegram bot the provider is <strong>channel.telegram.bot</strong>; when an unknown person writes to the bot, the Channels page shows an ignored inbound event with an <strong>Allow as Admin</strong> shortcut.</p>
        </div>
      </section>
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
            <input name="provider" placeholder="channel.telegram.bot" />
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
        <span>${escapeHtml(`${service.consecutiveFailureCount ?? 0} failures`)}</span>
        ${service.pendingRestartApproval ? `<span class="status-pill blocked">restart approval</span>` : ""}
        ${service.nextRestartAt ? `<span>${escapeHtml(`restart ${formatFutureRelative(service.nextRestartAt)}`)}</span>` : ""}
      </div>
      ${service.lastRestartAt ? `<small class="status-note">Last restart ${escapeHtml(formatRelative(service.lastRestartAt))}${service.lastRestartReason ? ` · ${escapeHtml(service.lastRestartReason)}` : ""}</small>` : ""}
      <small class="status-note">${escapeHtml(service.detail || "No service detail.")}</small>
      ${renderServiceRestartPolicyForm(service)}
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
  const canAllow =
    event.direction === "inbound" &&
    event.status === "ignored" &&
    event.sourceUserId &&
    event.toolName;
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
        ${canAllow ? `<button type="button" class="text-button accent-text" data-action="allow-event-identity" data-event-id="${escapeHtml(event.id)}">Allow as Admin</button>` : ""}
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
  const approvals = pendingApprovalItems();
  return `
    <section class="page-stack">
      <section class="surface-panel hero-panel">
        <div>
          <span class="eyebrow">CONTROL</span>
          <h2>Approvals</h2>
          <p>Human decisions before sensitive service restarts, outbound actions, memory writes, and generated artifacts.</p>
        </div>
        <span class="status-pill ${approvals.length ? "blocked" : "completed"}">${approvals.length} pending</span>
      </section>
      <section class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Decision Inbox</h2>
            <p>Items here are generic approval contracts, not provider-specific workflows.</p>
          </div>
        </div>
        <div class="approval-list">
          ${approvals.length ? approvals.map(renderApprovalCard).join("") : renderEmptyState("No pending approvals", "Sensitive actions that need a human decision will appear here.", "Approvals")}
        </div>
      </section>
    </section>
  `;
}

function renderApprovalCard(item) {
  if (item.type === "service-restart") {
    const service = item.service;
    return `
      <article class="approval-card">
        <div class="card-topline">
          <span>${escapeHtml(item.risk)}</span>
          <span>${escapeHtml(service.status)}</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.reason)}</p>
        <div class="service-status-row">
          <span class="status-pill blocked">approval required</span>
          <span>${escapeHtml(service.toolName)}</span>
          <span>${escapeHtml(`${service.consecutiveFailureCount ?? 0} failures`)}</span>
          ${service.lastFailureAt ? `<span>${escapeHtml(`failed ${formatRelative(service.lastFailureAt)}`)}</span>` : ""}
        </div>
        <small class="status-note">${escapeHtml(service.detail || "No service detail.")}</small>
        <div class="card-actions">
          <button type="button" class="primary-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="restart">Approve restart</button>
          <button type="button" class="ghost-button danger-button" data-action="tool-service-action" data-service-tool-name="${escapeHtml(service.toolName)}" data-service-action="stop">Reject and stop</button>
          <button type="button" class="ghost-button" data-action="navigate" data-route="channels">Open service</button>
        </div>
      </article>
    `;
  }
  return "";
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
  const runnerCards = state.toolPackageRunners.map((runner) => `
    <article class="tool-card">
      <div class="tool-card-header">
        <div>
          <span class="eyebrow">${escapeHtml(runner.type)}</span>
          <h3>${escapeHtml(runner.name ?? titleCase(String(runner.type ?? "runner").replace(/[-_]/g, " ")))}</h3>
        </div>
        ${statusBadge(runner.status ?? "available")}
      </div>
      <p>${escapeHtml(runner.detail ?? "No runner detail available.")}</p>
      <div class="chip-row">
        ${(runner.supportedPackageTypes ?? []).map((type) => `<span class="chip">${escapeHtml(type)}</span>`).join("")}
        ${runner.root ? `<span class="chip">root: ${escapeHtml(runner.root)}</span>` : ""}
      </div>
    </article>
  `).join("");

  return `
    <section class="page-grid">
      <div class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Diagnostics</h2>
            <p>Runtime health, generated package runners, queues, and operational checks.</p>
          </div>
        </div>
        <div class="metric-grid compact">
          ${metricCard("App", "Ready", "HTTP server responding")}
          ${metricCard("Tools", String(state.tools.length), "registered modules")}
          ${metricCard("Builds", String(state.buildRequests.length), "tool build requests")}
          ${metricCard("Services", String(state.toolServices.length), "always-on tools")}
        </div>
      </div>
      <div class="surface-panel">
        <div class="section-heading">
          <div>
            <h2>Package Runners</h2>
            <p>Execution adapters for portable tool package manifests.</p>
          </div>
          <button class="ghost-button" type="button" data-action="reload-generated-tools">Reload generated tools</button>
        </div>
        <div class="tool-grid">
          ${runnerCards || renderEmptyState("No package runners", "The app has not exposed any generated-tool package runners.", "Diagnostics")}
        </div>
      </div>
    </section>
  `;
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
  state.composerDraft = { task, threadMode, threadId, requesterUserId, channel };

  setComposerBusy(form, true);
  let shouldRenderError = false;

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
    if (!body.run?.id) throw new Error("Run API accepted the request but did not return a run id");

    state.composerDraft = undefined;
    state.error = undefined;
    state.notice = undefined;
    state.activeRunId = body.run.id;
    state.activeThreadId = body.run.threadId ?? state.activeThreadId;
    upsertRunInState(body.run);
    if (body.thread) upsertThreadInState(body.thread);
    connectRunStream(body.run.id);
    navigate(`run/${body.run.id}`);
    void refreshData({ soft: true });
  } catch (error) {
    state.notice = {
      type: "error",
      title: "Run was not started",
      body: error instanceof Error ? error.message : String(error),
    };
    shouldRenderError = true;
  } finally {
    setComposerBusy(form, false);
    if (shouldRenderError) render();
  }
}

function upsertRunInState(run) {
  const index = state.runs.findIndex((candidate) => candidate.id === run.id);
  if (index >= 0) state.runs[index] = run;
  else state.runs.unshift(run);
}

function upsertThreadInState(thread) {
  const index = state.conversations.findIndex((candidate) => candidate.id === thread.id);
  if (index >= 0) state.conversations[index] = thread;
  else state.conversations.unshift(thread);
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

async function allowEventIdentity(eventId) {
  const event = state.toolServiceEvents.find((candidate) => candidate.id === eventId);
  if (!event?.toolName || !event.sourceUserId) return;
  try {
    await fetchJson("/api/users/user-admin/channel-identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: event.toolName,
        providerUserId: event.sourceUserId,
        allowStatus: "allowed",
        displayMetadata: {
          source: "channels-runtime-event",
          sourceEventId: event.id,
          sourceChatId: event.sourceChatId,
          sourceMessageId: event.sourceMessageId,
        },
      }),
    });
    state.notice = {
      type: "success",
      title: "Channel identity allowed",
      body: `${event.toolName}/${event.sourceUserId} is now mapped to user-admin. New messages from this identity can create runs.`,
      route: "users",
      actionLabel: "Open Users",
    };
    await refreshData({ soft: true });
    render();
  } catch (error) {
    state.notice = {
      type: "error",
      title: "Could not allow identity",
      body: error instanceof Error ? error.message : String(error),
    };
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

async function reloadGeneratedTools() {
  try {
    const result = await fetchJson("/api/tools/reload-generated", { method: "POST" });
    await refreshData();
    state.notice = {
      title: "Generated tools reloaded",
      body: `${(result.tools ?? []).length} generated/builtin registry record${(result.tools ?? []).length === 1 ? "" : "s"} available after reload.`,
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

async function updateToolServiceRestartPolicy(form) {
  const data = new FormData(form);
  const toolName = normalizeOptionalInput(data.get("toolName"));
  if (!toolName) {
    state.error = "Tool service name is required";
    render();
    return;
  }
  const maxAutoRestarts = Number.parseInt(String(data.get("maxAutoRestarts") ?? "3"), 10);
  const restartBackoffMs = Number.parseInt(String(data.get("restartBackoffMs") ?? "0"), 10);
  const restartBackoffMultiplier = Number.parseFloat(String(data.get("restartBackoffMultiplier") ?? "1"));
  const restartBackoffMaxMs = Number.parseInt(String(data.get("restartBackoffMaxMs") ?? "0"), 10);
  const restartBackoffJitterRatio = Number.parseFloat(String(data.get("restartBackoffJitterRatio") ?? "0"));
  try {
    const result = await fetchJson(`/api/tool-services/${encodeURIComponent(toolName)}/restart-policy`, {
      method: "PATCH",
      body: JSON.stringify({
        autoRestartEnabled: data.get("autoRestartEnabled") === "on",
        maxAutoRestarts: Number.isFinite(maxAutoRestarts) ? Math.max(0, maxAutoRestarts) : 3,
        restartBackoffMs: Number.isFinite(restartBackoffMs) ? Math.max(0, restartBackoffMs) : 0,
        restartBackoffMultiplier: Number.isFinite(restartBackoffMultiplier)
          ? Math.max(1, restartBackoffMultiplier)
          : 1,
        restartBackoffMaxMs: Number.isFinite(restartBackoffMaxMs) ? Math.max(0, restartBackoffMaxMs) : 0,
        restartBackoffJitterRatio: Number.isFinite(restartBackoffJitterRatio)
          ? Math.min(1, Math.max(0, restartBackoffJitterRatio))
          : 0,
        restartRequiresApproval: data.get("restartRequiresApproval") === "on",
      }),
    });
    state.toolServices = [
      result.service,
      ...state.toolServices.filter((service) => service.toolName !== result.service.toolName),
    ].sort((a, b) => a.toolName.localeCompare(b.toolName));
    state.notice = {
      title: "Restart policy saved",
      body: `${result.service.displayName || result.service.toolName}: ${result.service.autoRestartEnabled === false ? "manual restart" : "auto restart"} · max ${result.service.maxAutoRestarts ?? 3}.`,
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

async function importToolPackageManifest(form) {
  const formData = new FormData(form);
  const rawManifest = String(formData.get("manifest") ?? "").trim();
  setComposerBusy(form, true);
  try {
    const manifest = JSON.parse(rawManifest);
    const data = await fetchJson("/api/tools/package-manifests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    state.tools = [data.tool, ...state.tools.filter((tool) => tool.name !== data.tool.name)].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    state.selectedToolName = data.tool.name;
    state.notice = {
      title: "Tool package imported",
      body: `${data.tool.displayName || data.tool.name} v${data.tool.version} was added to the registry.`,
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

async function saveToolRuntimeSettings(form) {
  const formData = new FormData(form);
  const toolName = String(formData.get("toolName") ?? "");
  const current = toolSettingsFor(toolName);
  const currentKeys = new Set(current.map((setting) => setting.key));
  const updates = [];
  const deletes = [];
  for (const [name, value] of formData.entries()) {
    if (!String(name).startsWith("setting:")) continue;
    const key = String(name).slice("setting:".length);
    const text = String(value ?? "").trim();
    if (text) updates.push({ toolName, key, value: text });
    else if (currentKeys.has(key)) deletes.push({ toolName, key });
  }
  const customKey = String(formData.get("customKey") ?? "").trim();
  const customValue = String(formData.get("customValue") ?? "").trim();
  if (customKey || customValue) {
    if (!customKey || !customValue) {
      state.error = "Optional runtime setting needs both key and value.";
      render();
      return;
    }
    updates.push({ toolName, key: customKey, value: customValue });
  }

  setComposerBusy(form, true);
  try {
    const validation = await fetchJson("/api/tool-settings/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName,
        settings: Object.fromEntries(updates.map((item) => [item.key, item.value])),
        deleteKeys: deletes.map((item) => item.key),
      }),
    });
    if (!validation.ok) {
      state.error = `Tool settings need attention: ${(validation.issues ?? []).join(" ")}`;
      render();
      return;
    }
    for (const item of updates) {
      await fetchJson("/api/tool-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item),
      });
    }
    for (const item of deletes) {
      await fetchJson(`/api/tool-settings/${encodeURIComponent(item.toolName)}/${encodeURIComponent(item.key)}`, {
        method: "DELETE",
      });
    }
    const refreshed = await fetchJson("/api/tool-settings");
    state.toolSettings = refreshed.settings ?? state.toolSettings;
    state.notice = {
      title: "Tool settings saved",
      body: `${toolName} runtime settings updated. ${(validation.warnings ?? []).join(" ") || "Secrets still resolve through Secret Handles."}`,
    };
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    setComposerBusy(form, false);
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
  return pendingApprovalItems().length;
}

function pendingApprovalItems() {
  return state.toolServices
    .filter((service) => service.pendingRestartApproval)
    .map((service) => ({
      id: `service-restart:${service.toolName}`,
      type: "service-restart",
      risk: "service restart",
      title: `Restart ${service.displayName || service.toolName}`,
      reason: "This always-on tool failed a heartbeat and its policy requires operator approval before recovery.",
      service,
    }));
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
      void refreshData({ soft: true });
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

function formatFutureRelative(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "now";
  if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`;
  return `in ${Math.ceil(diff / 3_600_000)}h`;
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
