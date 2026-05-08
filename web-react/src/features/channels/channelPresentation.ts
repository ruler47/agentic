import type {
  ChannelIdentityRecord,
  ToolServiceEventRecord,
  ToolServiceStatus,
  UserRecord,
} from "@/api/types";

export type ChannelIdentityView = ChannelIdentityRecord & {
  userDisplayName: string;
  userRole: string;
};

export type ChannelEventFilters = {
  service?: string;
  direction?: ToolServiceEventRecord["direction"] | "all";
  search?: string;
};

export type ChannelHealthSummary = {
  serviceCount: number;
  runningServices: number;
  pendingInbound: number;
  outboundNeedsAttention: number;
  allowedIdentities: number;
  blockedIdentities: number;
};

export function summarizeChannelHealth(input: {
  services: ToolServiceStatus[];
  events: ToolServiceEventRecord[];
  users: UserRecord[];
}): ChannelHealthSummary {
  const identities = flattenChannelIdentities(input.users);
  return {
    serviceCount: input.services.length,
    runningServices: input.services.filter((service) => service.status === "running").length,
    pendingInbound: input.events.filter(
      (event) => event.direction === "inbound" && (event.status === "ignored" || event.status === "received"),
    ).length,
    outboundNeedsAttention: input.events.filter(
      (event) => event.direction === "outbound" && (event.status === "queued" || event.status === "failed"),
    ).length,
    allowedIdentities: identities.filter((identity) => identity.allowStatus === "allowed").length,
    blockedIdentities: identities.filter((identity) => identity.allowStatus === "blocked").length,
  };
}

export function flattenChannelIdentities(users: UserRecord[]): ChannelIdentityView[] {
  return users
    .flatMap((user) =>
      user.identities.map((identity) => ({
        ...identity,
        userDisplayName: user.displayName,
        userRole: user.role,
      })),
    )
    .sort((a, b) => `${a.provider}:${a.providerUserId}`.localeCompare(`${b.provider}:${b.providerUserId}`));
}

export function filterChannelEvents(
  events: ToolServiceEventRecord[],
  filters: ChannelEventFilters,
): ToolServiceEventRecord[] {
  const search = filters.search?.trim().toLowerCase();
  return events
    .filter((event) => !filters.service || filters.service === "all" || event.toolName === filters.service)
    .filter((event) => !filters.direction || filters.direction === "all" || event.direction === filters.direction)
    .filter((event) => {
      if (!search) return true;
      return [
        event.toolName,
        event.direction,
        event.status,
        event.summary,
        event.sourceUserId,
        event.sourceChatId,
        event.sourceMessageId,
        event.threadId,
        event.runId,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    });
}

export function filterChannelIdentities(
  identities: ChannelIdentityView[],
  filters: { service?: string; search?: string },
): ChannelIdentityView[] {
  const search = filters.search?.trim().toLowerCase();
  return identities
    .filter((identity) => !filters.service || filters.service === "all" || identity.provider === filters.service)
    .filter((identity) => {
      if (!search) return true;
      return [
        identity.provider,
        identity.providerUserId,
        identity.allowStatus,
        identity.userDisplayName,
        identity.userRole,
      ].some((value) => String(value).toLowerCase().includes(search));
    });
}

export function eventTone(event: ToolServiceEventRecord): "ok" | "warn" | "danger" | "muted" {
  if (event.status === "failed") return "danger";
  if (event.status === "ignored" || event.status === "received" || event.status === "queued") return "warn";
  if (event.status === "sent") return "ok";
  return "muted";
}
