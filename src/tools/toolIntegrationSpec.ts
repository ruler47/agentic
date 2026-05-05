import type { ToolSchema, ToolStartupMode } from "./tool.js";
import type { ToolBuildRequestInput } from "./toolBuildRequestStore.js";

export type ToolIntegrationMode =
  | "on-demand-api"
  | "always-on-service"
  | "webhook-service"
  | "polling-service";

export type ToolIntegrationEventShape =
  | "message"
  | "file"
  | "voice"
  | "webhook"
  | "generic";

export type ToolIntegrationSpec = {
  kind: "integration";
  mode: ToolIntegrationMode;
  providerHint?: string;
  inbound: {
    enabled: boolean;
    eventShape: ToolIntegrationEventShape;
    mapsTo: "run" | "tool-event";
  };
  outbound: {
    enabled: boolean;
    eventShape: ToolIntegrationEventShape;
    source: "outbox" | "tool-call";
  };
  credentials: {
    handles: string[];
    inferredFromNotes: boolean;
    required: boolean;
  };
  settings: Array<{
    key: string;
    description: string;
    required: boolean;
    secret: boolean;
  }>;
  lifecycle: {
    startupMode: ToolStartupMode;
    healthcheckRequired: boolean;
    supervisorManaged: boolean;
    qaRequired: string[];
  };
  notes: string[];
};

export function inferToolIntegrationSpec(input: ToolBuildRequestInput): ToolIntegrationSpec | undefined {
  const text = [
    input.capability,
    input.displayName,
    input.reason,
    input.taskSummary,
    input.desiredToolName,
    input.credentialNotes,
    (input.requiredInputs ?? []).join(" "),
    (input.requiredOutputs ?? []).join(" "),
  ].join(" ");
  const providerHint = inferProviderHint(text);
  const wantsService = input.startupMode === "always-on" || /\b(bot|listener|service|webhook|polling|inbound|outbound|channel|messaging|always[-\s]?on)\b/i.test(text);
  const wantsApi = /\b(api|endpoint|openapi|swagger|http|https?:\/\/|json api)\b/i.test(text);

  if (!wantsService && !wantsApi && !providerHint) return undefined;

  const eventShape = inferEventShape(text);
  const mode = inferMode(text, input.startupMode, wantsService);
  const handles = input.credentialHandles?.length
    ? [...new Set(input.credentialHandles)]
    : input.credentialNotes?.trim()
      ? [secretHandleFromCapability(input.capability)]
      : [];

  return {
    kind: "integration",
    mode,
    providerHint,
    inbound: {
      enabled: mode !== "on-demand-api" && /\b(inbound|incoming|receive|message|file|voice|webhook|bot|listener|polling)\b/i.test(text),
      eventShape,
      mapsTo: "run",
    },
    outbound: {
      enabled: mode !== "on-demand-api" && /\b(outbound|reply|send|message|file|document|photo|notification|broadcast|bot)\b/i.test(text),
      eventShape: /\b(file|document|photo|artifact|image)\b/i.test(text) ? "file" : "message",
      source: "outbox",
    },
    credentials: {
      handles,
      inferredFromNotes: !input.credentialHandles?.length && !!input.credentialNotes?.trim(),
      required: handles.length > 0 || /\b(token|api[-\s]?key|secret|credential|oauth|bearer)\b/i.test(text),
    },
    settings: inferSettings(text, providerHint, handles),
    lifecycle: {
      startupMode: input.startupMode ?? (mode === "on-demand-api" ? "on-demand" : "always-on"),
      healthcheckRequired: true,
      supervisorManaged: mode !== "on-demand-api",
      qaRequired: [
        "Generated module imports and exposes a standard Tool contract.",
        "Declared secret handles are resolved at runtime and raw secrets never appear in source, tests, logs, traces, or docs.",
        "Lifecycle healthcheck is observable before and after startup.",
        "Inbound/outbound events use the neutral integration event contract.",
        "Manual smoke evidence is attached before promotion.",
      ],
    },
    notes: [
      "Provider APIs must be mapped into this neutral contract; generated modules must not import Agentic internals.",
      "If provider-specific behavior is needed, implement it behind the same input/output/event contract.",
      "Long-running integrations must be supervised by the runtime and support stop/restart through the Tool service handle.",
    ],
  };
}

export function integrationSettingsSchema(spec: ToolIntegrationSpec): ToolSchema {
  const properties: Record<string, unknown> = {
    enabled: { type: "boolean" },
    mode: { type: "string" },
    providerHint: { type: "string" },
    eventMapping: { type: "object" },
  };
  const required = ["enabled"];

  for (const setting of spec.settings) {
    properties[setting.key] = setting.secret
      ? { type: "string", description: setting.description, secret: true }
      : { type: "string", description: setting.description };
    if (setting.required) required.push(setting.key);
  }

  return {
    type: "object",
    properties,
    required,
  };
}

export function integrationDocsMarkdown(spec: ToolIntegrationSpec): string {
  const provider = spec.providerHint ?? "generic provider";
  return [
    "## Integration contract",
    "",
    `Mode: \`${spec.mode}\`. Provider hint: \`${provider}\`.`,
    `Inbound: ${spec.inbound.enabled ? `${spec.inbound.eventShape} -> ${spec.inbound.mapsTo}` : "disabled"}.`,
    `Outbound: ${spec.outbound.enabled ? `${spec.outbound.eventShape} from ${spec.outbound.source}` : "disabled"}.`,
    spec.credentials.handles.length
      ? `Secret handles: ${spec.credentials.handles.map((handle) => `\`${handle}\``).join(", ")}.`
      : "No secret handles were declared by the request.",
    "",
    "Lifecycle:",
    `- startup mode: \`${spec.lifecycle.startupMode}\``,
    `- supervisor managed: ${spec.lifecycle.supervisorManaged ? "yes" : "no"}`,
    "- healthcheck required before promotion",
    "",
    "QA requirements:",
    ...spec.lifecycle.qaRequired.map((item) => `- ${item}`),
  ].join("\n");
}

function inferMode(text: string, startupMode: ToolStartupMode | undefined, wantsService: boolean): ToolIntegrationMode {
  if (startupMode === "always-on") return "always-on-service";
  if (/\bwebhook\b/i.test(text)) return "webhook-service";
  if (/\bpolling|poller\b/i.test(text)) return "polling-service";
  if (wantsService) return "always-on-service";
  return "on-demand-api";
}

function inferProviderHint(text: string): string | undefined {
  const pairs: Array<[RegExp, string]> = [
    [/\btelegram\b/i, "telegram"],
    [/\bslack\b/i, "slack"],
    [/\bwhats?app\b/i, "whatsapp"],
    [/\bdiscord\b/i, "discord"],
    [/\bemail|smtp|imap|gmail\b/i, "email"],
    [/\bgithub\b/i, "github"],
    [/\bwebhook\b/i, "webhook"],
  ];
  return pairs.find(([pattern]) => pattern.test(text))?.[1];
}

function inferEventShape(text: string): ToolIntegrationEventShape {
  if (/\bvoice|audio|speech\b/i.test(text)) return "voice";
  if (/\bfile|document|photo|image|artifact|attachment\b/i.test(text)) return "file";
  if (/\bwebhook\b/i.test(text)) return "webhook";
  if (/\bmessage|chat|bot|channel|reply|telegram|slack|whats?app|discord\b/i.test(text)) return "message";
  return "generic";
}

function inferSettings(
  text: string,
  providerHint: string | undefined,
  handles: string[],
): ToolIntegrationSpec["settings"] {
  const settings: ToolIntegrationSpec["settings"] = [];
  if (providerHint) {
    settings.push({
      key: "provider",
      description: `Provider adapter hint (${providerHint}).`,
      required: true,
      secret: false,
    });
  }
  if (/\bwebhook\b/i.test(text)) {
    settings.push({
      key: "webhookPath",
      description: "Relative webhook path exposed by this integration.",
      required: false,
      secret: false,
    });
  }
  if (/\bwhitelist|allowed users?|allowlist\b/i.test(text)) {
    settings.push({
      key: "allowedIdentities",
      description: "Comma-separated provider identities allowed to create events.",
      required: false,
      secret: false,
    });
  }
  for (const handle of handles) {
    settings.push({
      key: handle.replace(/^secret\./, "secretHandle.").replace(/[^a-zA-Z0-9_.-]+/g, "."),
      description: `Secret handle ${handle}.`,
      required: true,
      secret: true,
    });
  }
  return settings;
}

function secretHandleFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[.:-]+$/g, "")
    .slice(0, 96) || "generated.integration";
  return `secret.${slug}`;
}
