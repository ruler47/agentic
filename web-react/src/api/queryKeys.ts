/**
 * Centralized React Query keys. Keeping them in one place avoids the typical
 * "I changed the cache key in one hook but invalidated the wrong one in another"
 * class of bug.
 */
export const queryKeys = {
  health: ["health"] as const,
  instance: ["instance"] as const,
  groupProfile: ["group-profile"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["runs", id] as const,
  actionProposals: ["action-proposals"] as const,
  conversations: ["conversation-threads"] as const,
  conversation: (id: string) => ["conversation-threads", id] as const,
  tools: ["tools"] as const,
  toolContext: (name: string) => ["tools", name, "context"] as const,
  toolCreations: ["tool-creations"] as const,
  toolPackageRunners: ["tool-package-runners"] as const,
  toolMigrations: ["tool-migrations"] as const,
  toolPromotions: ["tool-promotions"] as const,
  toolSettings: ["tool-settings"] as const,
  toolServices: ["tool-services"] as const,
  toolServiceLogs: ["tool-services", "logs"] as const,
  toolServiceEvents: ["tool-service-events"] as const,
  secretHandles: ["secret-handles"] as const,
  secretHandleStatuses: (handles: string[]) => ["secret-handles", "status", [...handles].sort()] as const,
  modelTiers: ["settings", "model-tiers"] as const,
  modelProviders: ["model-providers"] as const,
  modelProfiles: ["model-profiles"] as const,
  modelCatalog: ["models", "catalog"] as const,
  users: ["users"] as const,
  memories: ["memories"] as const,
  memoryReviews: ["memories", "review-queue"] as const,
  auditEvents: ["audit-events"] as const,
  workLedger: (scope: string) => ["work-ledger", scope] as const,
  evidenceLedger: (scope: string) => ["evidence-ledger", scope] as const,
  runRetrospectives: (scope: string) => ["run-retrospectives", scope] as const,
} as const;
