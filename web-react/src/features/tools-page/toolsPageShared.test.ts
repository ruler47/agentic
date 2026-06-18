import { describe, expect, it } from "vitest";
import type { ToolModuleMetadata } from "@/api/types";

import { inferCreationKindFromTool } from "./toolsPageShared";

describe("toolsPageShared", () => {
  it("keeps always-on generated tools on the service-adapter edit strategy", () => {
    expect(inferCreationKindFromTool({
      name: "channel.telegram",
      version: "0.1.2",
      description: "telegram bot for requesting runs",
      capabilities: ["telegram-channel", "always-on-messaging"],
      startupMode: "always-on",
      source: "generated",
      status: "available",
      requiredConfigurationKeys: [],
      requiredSecretHandles: ["secret.telegram.bot"],
      examples: [],
      successCount: 0,
      failureCount: 0,
      updatedAt: "2026-05-21T00:00:00.000Z",
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1",
        name: "channel.telegram",
        version: "0.1.2",
        description: "telegram bot for requesting runs",
        startupMode: "always-on",
        capabilities: ["telegram-channel", "always-on-messaging"],
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
        package: { type: "source-bundle", ref: "channel.telegram/0.1.2" },
        requiredSecretHandles: ["secret.telegram.bot"],
        requiredConfigurationKeys: [],
        integration: {
          schemaVersion: "agentic.tool-integration.v1",
          mode: "always-on-service",
          protocol: "messaging-bot",
          provider: "telegram",
          operations: [],
        },
      },
    } as ToolModuleMetadata)).toBe("service-adapter");
  });
});
