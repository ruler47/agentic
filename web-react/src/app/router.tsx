import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageLoader } from "@/components/PageLoader";
import { DashboardPage } from "@/routes/Dashboard";
import { PlaceholderPage } from "@/routes/PlaceholderPage";

// Lazy-loaded route bundles. Each chunk is fetched on demand, which is
// especially important for Trace Lab — @xyflow/react alone is ~140KB and is
// only needed when the operator opens a graph.
const RunsPage = lazy(() => import("@/routes/Runs").then((m) => ({ default: m.RunsPage })));
const RunWorkspacePage = lazy(() =>
  import("@/routes/RunWorkspace").then((m) => ({ default: m.RunWorkspacePage })),
);
const TraceLabDirectoryPage = lazy(() =>
  import("@/routes/TraceLab").then((m) => ({ default: m.TraceLabDirectoryPage })),
);
const TraceLabRunPage = lazy(() =>
  import("@/routes/TraceLabRun").then((m) => ({ default: m.TraceLabRunPage })),
);
const ConversationsPage = lazy(() =>
  import("@/routes/Conversations").then((m) => ({ default: m.ConversationsPage })),
);
const ConversationDetailPage = lazy(() =>
  import("@/routes/ConversationDetail").then((m) => ({ default: m.ConversationDetailPage })),
);
const MemoryPage = lazy(() => import("@/routes/Memory").then((m) => ({ default: m.MemoryPage })));
const ArtifactsPage = lazy(() =>
  import("@/routes/Artifacts").then((m) => ({ default: m.ArtifactsPage })),
);
const ToolsPage = lazy(() => import("@/routes/Tools").then((m) => ({ default: m.ToolsPage })));
const ToolBuildsPage = lazy(() =>
  import("@/routes/ToolBuilds").then((m) => ({ default: m.ToolBuildsPage })),
);
const ModelsPage = lazy(() => import("@/routes/Models").then((m) => ({ default: m.ModelsPage })));
const GroupProfilePage = lazy(() =>
  import("@/routes/GroupProfile").then((m) => ({ default: m.GroupProfilePage })),
);
const UsersPage = lazy(() => import("@/routes/Users").then((m) => ({ default: m.UsersPage })));
const ChannelsPage = lazy(() =>
  import("@/routes/Channels").then((m) => ({ default: m.ChannelsPage })),
);
const ApprovalsPage = lazy(() =>
  import("@/routes/Approvals").then((m) => ({ default: m.ApprovalsPage })),
);
const AuditLogPage = lazy(() =>
  import("@/routes/AuditLog").then((m) => ({ default: m.AuditLogPage })),
);
const SettingsPage = lazy(() =>
  import("@/routes/Settings").then((m) => ({ default: m.SettingsPage })),
);
const DiagnosticsPage = lazy(() =>
  import("@/routes/Diagnostics").then((m) => ({ default: m.DiagnosticsPage })),
);

function lazyRoute(element: React.ReactNode) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>{element}</Suspense>
    </ErrorBoundary>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },

      { path: "runs", element: lazyRoute(<RunsPage />) },
      { path: "run/:runId", element: lazyRoute(<RunWorkspacePage />) },

      { path: "conversations", element: lazyRoute(<ConversationsPage />) },
      { path: "conversation/:threadId", element: lazyRoute(<ConversationDetailPage />) },

      { path: "trace", element: lazyRoute(<TraceLabDirectoryPage />) },
      { path: "trace/:runId", element: lazyRoute(<TraceLabRunPage />) },

      { path: "memory", element: lazyRoute(<MemoryPage />) },
      { path: "artifacts", element: lazyRoute(<ArtifactsPage />) },

      { path: "tools", element: lazyRoute(<ToolsPage />) },
      { path: "tool-builds", element: lazyRoute(<ToolBuildsPage />) },
      { path: "models", element: lazyRoute(<ModelsPage />) },

      { path: "group-profile", element: lazyRoute(<GroupProfilePage />) },
      { path: "users", element: lazyRoute(<UsersPage />) },
      { path: "channels", element: lazyRoute(<ChannelsPage />) },
      {
        path: "policies",
        element: (
          <PlaceholderPage
            title="Policies"
            description="Memory access, tool permissions, outbound, approvals, federation. Backend still planned (Phase 11 of the agent roadmap)."
          />
        ),
      },
      { path: "approvals", element: lazyRoute(<ApprovalsPage />) },
      {
        path: "scheduler",
        element: (
          <PlaceholderPage
            title="Scheduler"
            description="Reminders, recurring jobs, and alerts. Backend planned (Phase 10 of the agent roadmap)."
          />
        ),
      },
      { path: "audit-log", element: lazyRoute(<AuditLogPage />) },
      { path: "settings", element: lazyRoute(<SettingsPage />) },
      { path: "diagnostics", element: lazyRoute(<DiagnosticsPage />) },

      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
