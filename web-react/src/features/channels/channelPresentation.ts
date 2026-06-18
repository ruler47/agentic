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

export type PendingChannelUser = {
  key: string;
  event: ToolServiceEventRecord;
  provider: string;
  sourceUserId: string;
  aliases: string[];
  messageCount: number;
  latestAt: string;
  hasBlockedIdentity: boolean;
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

export function findPendingChannelUsers(input: {
  events: ToolServiceEventRecord[];
  identities: ChannelIdentityView[];
  service?: string;
  search?: string;
}): PendingChannelUser[] {
  const search = input.search?.trim().toLowerCase();
  const allowedKeys = new Set(
    input.identities
      .filter((identity) => identity.allowStatus === "allowed")
      .map((identity) => identityKey(identity.provider, identity.providerUserId)),
  );
  const blockedKeys = new Set(
    input.identities
      .filter((identity) => identity.allowStatus === "blocked")
      .map((identity) => identityKey(identity.provider, identity.providerUserId)),
  );
  const grouped = new Map<string, PendingChannelUser>();
  for (const event of input.events) {
    if (event.direction !== "inbound" || !event.sourceUserId || event.runId) continue;
    if (event.status !== "ignored" && event.status !== "received") continue;
    if (input.service && input.service !== "all" && event.toolName !== input.service) continue;
    const ids = uniqueStrings([event.sourceUserId, ...sourceAliasesFromEvent(event)]);
    if (ids.some((id) => allowedKeys.has(identityKey(event.toolName, id)))) continue;
    const key = `${event.toolName}:${event.sourceUserId}:${event.sourceChatId ?? ""}`;
    const existing = grouped.get(key);
    const hasBlockedIdentity = ids.some((id) => blockedKeys.has(identityKey(event.toolName, id)));
    if (!existing) {
      grouped.set(key, {
        key,
        event,
        provider: event.toolName,
        sourceUserId: event.sourceUserId,
        aliases: ids.filter((id) => id !== event.sourceUserId),
        messageCount: 1,
        latestAt: event.createdAt,
        hasBlockedIdentity,
      });
      continue;
    }
    existing.messageCount += 1;
    existing.hasBlockedIdentity = existing.hasBlockedIdentity || hasBlockedIdentity;
    if (new Date(event.createdAt).getTime() > new Date(existing.latestAt).getTime()) {
      existing.event = event;
      existing.latestAt = event.createdAt;
    }
  }
  return [...grouped.values()]
    .filter((pending) => {
      if (!search) return true;
      return [
        pending.provider,
        pending.sourceUserId,
        ...pending.aliases,
        pending.event.sourceChatId,
        pending.event.summary,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    })
    .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
}

export function eventTone(event: ToolServiceEventRecord): "ok" | "warn" | "danger" | "muted" {
  if (event.status === "failed") return "danger";
  if (event.status === "ignored" || event.status === "received" || event.status === "queued") return "warn";
  if (event.status === "sent") return "ok";
  return "muted";
}

function sourceAliasesFromEvent(event: ToolServiceEventRecord): string[] {
  const payload = event.payload;
  if (!payload) return [];
  const raw = payload.sourceUserAliases;
  const aliases = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  const username =
    typeof payload.username === "string"
      ? payload.username
      : typeof payload.sourceUsername === "string"
        ? payload.sourceUsername
        : typeof payload.sourceUserName === "string"
          ? payload.sourceUserName
          : undefined;
  return uniqueStrings([
    ...aliases,
    username,
    username && !username.startsWith("@") ? `@${username}` : undefined,
  ]);
}

function identityKey(provider: string, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}
