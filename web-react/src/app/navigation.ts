/**
 * Single source of truth for sidebar navigation.
 */

export type NavItem = {
  id: string;
  label: string;
  description: string;
  path: string;
};

export type NavGroup = {
  group: string;
  items: NavItem[];
};

export const navigation: NavGroup[] = [
  {
    group: "Work",
    items: [
      { id: "dashboard", label: "Dashboard", description: "Start work and monitor active agent runs.", path: "/" },
      { id: "runs", label: "Runs", description: "Search and reopen past executions.", path: "/runs" },
      { id: "conversations", label: "Conversations", description: "Continue threads and inspect context.", path: "/conversations" },
    ],
  },
  {
    group: "Analysis",
    items: [
      { id: "trace", label: "Trace Lab", description: "Debug agent timelines, graphs, and logs.", path: "/trace" },
      { id: "ledger", label: "Ledger", description: "Work claims, evidence, and run retrospectives.", path: "/ledger" },
      { id: "memory", label: "Memory", description: "Review scoped knowledge and proposed facts.", path: "/memory" },
      { id: "artifacts", label: "Artifacts", description: "Browse generated files and proof.", path: "/artifacts" },
    ],
  },
  {
    group: "Build",
    items: [
      { id: "tools", label: "Tools", description: "Registry, schemas, health, and credentials.", path: "/tools" },
      { id: "models", label: "Models", description: "Providers, tiers, fallbacks, and health.", path: "/models" },
    ],
  },
  {
    group: "Control",
    items: [
      { id: "group-profile", label: "Group Profile", description: "Shared context, preferences, rules, and goals.", path: "/group-profile" },
      { id: "users", label: "Users", description: "Members, identities, roles, and access.", path: "/users" },
      { id: "channels", label: "Channels", description: "Runtime view for always-on intake tools and message routing.", path: "/channels" },
      { id: "policies", label: "Policies", description: "Memory, tools, outbound, and federation rules.", path: "/policies" },
      { id: "approvals", label: "Approvals", description: "Human decisions before sensitive actions.", path: "/approvals" },
      { id: "scheduler", label: "Scheduler", description: "Reminders, recurring jobs, and alerts.", path: "/scheduler" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "audit-log", label: "Audit Log", description: "Every significant action, decision, and change.", path: "/audit-log" },
      { id: "settings", label: "Settings", description: "Instance, locale, storage, secrets, and backups.", path: "/settings" },
      { id: "diagnostics", label: "Diagnostics", description: "Runtime health and operational tools.", path: "/diagnostics" },
    ],
  },
];

export const allNavItems: NavItem[] = navigation.flatMap((group) => group.items);
