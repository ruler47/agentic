import { describe, expect, it } from "vitest";
import type { ToolServiceEventRecord, ToolServiceStatus, UserRecord } from "@/api/types";
import {
  filterChannelEvents,
  filterChannelIdentities,
  flattenChannelIdentities,
  summarizeChannelHealth,
} from "./channelPresentation";

const baseService: ToolServiceStatus = {
  toolName: "generated.telegram.family-bot",
  displayName: "Family bot",
  description: "Test service",
  status: "running",
  desiredState: "running",
  detail: "ok",
  updatedAt: new Date(0).toISOString(),
  restartCount: 0,
  consecutiveFailureCount: 0,
};

const events: ToolServiceEventRecord[] = [
  {
    id: "evt-1",
    toolName: "generated.telegram.family-bot",
    direction: "inbound",
    status: "ignored",
    summary: "Denied @dima",
    sourceUserId: "100",
    sourceChatId: "chat-1",
    createdAt: new Date(0).toISOString(),
  },
  {
    id: "evt-2",
    toolName: "generated.telegram.family-bot",
    direction: "outbound",
    status: "queued",
    summary: "Answer pending",
    runId: "run-1",
    createdAt: new Date(1).toISOString(),
  },
  {
    id: "evt-3",
    toolName: "generated.slack.ops-bot",
    direction: "outbound",
    status: "sent",
    summary: "Delivered",
    createdAt: new Date(2).toISOString(),
  },
];

const users: UserRecord[] = [
  {
    id: "user-admin",
    displayName: "Admin",
    role: "admin",
    roles: ["admin"],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    identities: [
      {
        id: "identity-1",
        provider: "generated.telegram.family-bot",
        providerUserId: "100",
        userId: "user-admin",
        allowStatus: "allowed",
        displayMetadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: "identity-2",
        provider: "generated.slack.ops-bot",
        providerUserId: "U123",
        userId: "user-admin",
        allowStatus: "blocked",
        displayMetadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
  },
];

describe("channelPresentation", () => {
  it("summarizes service, event, and identity health", () => {
    expect(
      summarizeChannelHealth({
        services: [baseService, { ...baseService, toolName: "stopped", status: "stopped" }],
        events,
        users,
      }),
    ).toEqual({
      serviceCount: 2,
      runningServices: 1,
      pendingInbound: 1,
      outboundNeedsAttention: 1,
      allowedIdentities: 1,
      blockedIdentities: 1,
    });
  });

  it("filters events by service, direction, and search text", () => {
    expect(
      filterChannelEvents(events, {
        service: "generated.telegram.family-bot",
        direction: "outbound",
        search: "pending",
      }).map((event) => event.id),
    ).toEqual(["evt-2"]);
  });

  it("flattens and filters identities with user labels", () => {
    const identities = flattenChannelIdentities(users);
    expect(identities[0]?.userDisplayName).toBe("Admin");
    expect(
      filterChannelIdentities(identities, {
        service: "generated.telegram.family-bot",
        search: "100",
      }).map((identity) => identity.id),
    ).toEqual(["identity-1"]);
  });
});
