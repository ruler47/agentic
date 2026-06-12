import type { ToolCreationV1Input } from "./toolCreationV1.js";
import {
  type ToolBehaviorExample,
  type ToolBuilderCandidate,
  type ToolBuilderDiscoveryEvidence,
  type ToolBuilderStrategyDecision,
  type ToolCreationDependency,
} from "./toolCreationStore.js";
import {
  mergeToolIntegrationContracts,
  normalizeToolIntegrationContract,
  type ToolIntegrationContract,
} from "./toolIntegrationContract.js";
import type { ToolSchema, ToolStartupMode } from "./tool.js";

export type ToolBuilderRequest = {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  request: string;
  sourceTask?: string;
  capabilities?: string[];
  dependencies?: Record<string, string>;
  behaviorExamples?: ToolBehaviorExample[];
  legacyKind?: ToolCreationV1Input["kind"];
  authoringMode?: "auto" | "llm" | "scaffold";
  startupMode?: ToolStartupMode;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
  settingsSchema?: ToolSchema;
  integrationContract?: ToolIntegrationContract;
};

export type ToolBuilderPlanOptions = {
  discoveredCandidates?: ToolBuilderCandidate[];
  discoveredDependencies?: Record<string, string>;
  discoveryEvidence?: ToolBuilderDiscoveryEvidence[];
  discoveryNotes?: string[];
};

export type ToolBuilderPlan = {
  input: ToolCreationV1Input;
  strategy: ToolBuilderStrategyDecision;
  authoringMode?: ToolBuilderRequest["authoringMode"];
};

export function buildToolBuilderPlan(rawInput: unknown, options: ToolBuilderPlanOptions = {}): ToolBuilderPlan {
  const request = normalizeBuilderRequest(rawInput);
  const dependencies = request.dependencies ?? options.discoveredDependencies ?? {};
  const selectedDependencies = dependencyRecords(dependencies);
  const candidates = candidateStrategies(request, selectedDependencies, options.discoveredCandidates ?? []);
  const selected = candidates[0] ?? {
    kind: "custom-typescript" as const,
    name: "custom-typescript",
    reason: "No better reusable package/API strategy was evident from the request.",
  };
  const rejectedCandidates = candidates.slice(1);
  const actionPreparer = isExternalActionPrepareRequest(request);
  const commitExecutor = isExternalActionCommitRequest(request);
  const kind = request.legacyKind ?? (actionPreparer ? "external-action-prepare" : commitExecutor ? "external-action-commit" : selected.kind === "external-api"
    ? "http-json"
    : selected.kind === "web-search"
      ? "web-search"
    : selected.kind === "web-read"
      ? "web-read"
    : selected.kind === "npm-package"
      ? "npm-default-function"
    : selected.kind === "container-service"
      ? "service-adapter"
      : selected.kind === "browser-automation"
        ? inferBrowserAutomationKind(request)
      : "echo");
  const adapterPackageName = selected.kind === "npm-package"
    ? selected.packageName ?? selectedDependencies[0]?.name
    : undefined;
  const adapterContract = selected.kind === "npm-package" && selected.adapterContract
    ? selected.adapterContract
    : adapterPackageName
      ? {
          packageName: adapterPackageName,
          importStyle: "default" as const,
          inputMode: "text-options" as const,
          evidence: "Default callable adapter contract inferred from selected npm package dependency.",
        }
      : undefined;
  const behaviorExamples = request.behaviorExamples ?? inferBehaviorExamples(request, selected, adapterPackageName);
  const integrationContract = mergeToolIntegrationContracts(
    request.integrationContract,
    selected.integrationContract,
  ) ?? (commitExecutor ? undefined : inferIntegrationContract(request, selected));
  const startupMode = request.startupMode ?? (integrationContract?.mode === "always-on-service" ? "always-on" : "on-demand");
  const requiredSecretHandles = uniqueStrings([
    ...(request.requiredSecretHandles ?? []),
    ...(integrationContract?.auth?.requiredSecretHandles ?? []),
    ...integrationContractRequiredSecretHandles(integrationContract),
  ]);
  const requiredConfigurationKeys = uniqueStrings([
    ...(request.requiredConfigurationKeys ?? []),
    ...(integrationContract?.auth?.requiredConfigurationKeys ?? []),
    ...integrationContractRequiredConfigurationKeys(integrationContract),
  ]);

  const strategy: ToolBuilderStrategyDecision = {
    kind: selected.kind,
    reason: selected.reason,
    confidence: selected.kind === "npm-package" && adapterPackageName && behaviorExamples.length > 0 ? "high" : selected.kind === "npm-package" && adapterPackageName ? "medium" : "low",
    candidates,
    rejectedCandidates,
    selectedDependencies,
    discoveryEvidence: options.discoveryEvidence,
    adapterContract,
    integrationContract,
    behaviorExamples,
    implementationNotes: implementationNotes(selected, adapterPackageName, adapterContract, integrationContract),
  };
  if (options.discoveryNotes?.length) {
    strategy.implementationNotes.push(...options.discoveryNotes.map((note) => `Discovery: ${note}`));
  }

  return {
    input: {
      name: request.name ?? inferToolName(request.request),
      displayName: request.displayName,
      version: request.version ?? "0.1.0",
      description: request.description ?? inferDescription(request.request, selected.name),
      request: request.request,
      kind,
      startupMode,
      capabilities: request.capabilities ?? inferCapabilities(request.request, actionPreparer ? "external-action-prepare" : commitExecutor ? "external-action-commit" : selected.kind),
      dependencies,
      adapterPackageName,
      adapterContract,
      integrationContract,
      requiredSecretHandles,
      requiredConfigurationKeys,
      settingsSchema: request.settingsSchema,
      behaviorExamples,
    },
    strategy,
    authoringMode: request.authoringMode,
  };
}

function normalizeBuilderRequest(rawInput: unknown): ToolBuilderRequest {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("tool builder request must be an object");
  }
  const body = rawInput as Record<string, unknown>;
  const request = text(body.request ?? body.desiredBehavior ?? body.task, "request");
  return {
    name: optionalText(body.name, "name"),
    displayName: optionalText(body.displayName, "displayName"),
    version: optionalText(body.version, "version"),
    description: optionalText(body.description, "description"),
    request,
    sourceTask: optionalText(body.sourceTask ?? body.originalTask ?? body.taskContext, "sourceTask"),
    capabilities: stringArray(body.capabilities, "capabilities"),
    dependencies: dependencyMap(body.dependencies),
    behaviorExamples: behaviorExamples(body.behaviorExamples),
    legacyKind: legacyKind(body.kind),
    authoringMode: authoringMode(body.authoringMode),
    startupMode: startupMode(body.startupMode),
    requiredSecretHandles: stringArray(body.requiredSecretHandles, "requiredSecretHandles"),
    requiredConfigurationKeys: stringArray(body.requiredConfigurationKeys, "requiredConfigurationKeys"),
    settingsSchema: optionalSchema(body.settingsSchema, "settingsSchema"),
    integrationContract: body.integration === undefined ? undefined : normalizeToolIntegrationContract(body.integration),
  };
}

function candidateStrategies(
  request: ToolBuilderRequest,
  dependencies: ToolCreationDependency[],
  discoveredCandidates: ToolBuilderCandidate[],
): ToolBuilderCandidate[] {
  const lower = request.request.toLowerCase();
  const candidates: ToolBuilderCandidate[] = [];
  const serviceCandidate = inferServiceCandidate(lower);
  if (request.legacyKind) {
    const compatibilityCandidate = {
      kind: "template",
      name: `${request.legacyKind} compatibility template`,
      reason: "The request used the legacy structured kind field, so the builder keeps compatibility while recording the strategy explicitly.",
    } satisfies ToolBuilderCandidate;
    candidates.push(...discoveredCandidates, compatibilityCandidate);
    return candidates;
  }
  if (serviceCandidate) candidates.push(serviceCandidate);
  candidates.push(...discoveredCandidates);
  if (dependencies.length > 0) {
    const dependency = dependencies[0];
    if (!candidates.some((candidate) => candidate.kind === "npm-package" && candidate.packageName === dependency.name)) {
      candidates.push({
        kind: "npm-package",
        name: "npm default callable adapter",
        packageName: dependency.name,
        versionRange: dependency.versionRange,
        reason: `A package dependency was declared for this capability, so the builder can keep the implementation out of Agentic and wrap ${dependency.name} inside the generated package.`,
      });
    }
  }
  const explicitBrowserOperate = /\b(browser[.\s_-]*operate|click|fill|type|select|submit|form|booking|reservation|appointment|prepare[-\s]?only|stop before commit|web automation)\b/.test(lower);
  if (explicitBrowserOperate) {
    candidates.push({
      kind: "browser-automation",
      name: "browser operation package",
      reason: "The request needs browser page interaction in prepare mode before any final external commit.",
    });
  }
  if (/\b(web\s+search|internet\s+search|search\s+engine|search results?|current (?:news|price|prices|information|data)|real-time|realtime)\b/.test(lower)) {
    candidates.push({
      kind: "web-search",
      name: "web search package",
      reason: "The request needs live internet search results rather than fetching one known URL.",
    });
  }
  if (/\b(read|extract|scrape|fetch|parse)\b.*\b(web\s+page|page|url|html|article|document)\b|\b(web\s+read|web\s+extract|page\s+extract|article\s+text)\b/.test(lower)) {
    candidates.push({
      kind: "web-read",
      name: "web page reader package",
      reason: "The request needs to fetch a known URL and extract readable page text/links rather than only search snippets.",
    });
  }
  if (!explicitBrowserOperate && /\b(browser|click|form|screenshot|web page|page)\b/.test(lower)) {
    candidates.push({
      kind: "browser-automation",
      name: "browser automation package",
      reason: "The request appears to need browser state or web-page interaction.",
    });
  }
  if (/\b(api|http|json|fetch|url|endpoint|rest|graphql)\b/.test(lower)) {
    candidates.push({
      kind: "external-api",
      name: "external API client",
      reason: "The request describes fetching or calling an HTTP/API endpoint.",
    });
  }
  candidates.push({
    kind: "custom-typescript",
    name: "custom TypeScript package",
    reason: "Fallback strategy when no reusable dependency, API, or runtime strategy is clearly better.",
  });
  return candidates;
}

function inferServiceCandidate(lowerRequest: string): ToolBuilderCandidate | undefined {
  if (!/\b(bot|telegram|whatsapp|slack|discord|webhook|listener|listen|poll|always[-\s]?on|receive messages?|incoming messages?|inbound|channel)\b/.test(lowerRequest)) {
    return undefined;
  }
  return {
    kind: "container-service",
    name: "always-on service adapter",
    reason: "The request describes a long-running integration that receives events and forwards them into normal runs.",
  };
}

function legacyKind(value: unknown): ToolBuilderRequest["legacyKind"] {
  if (value === undefined) return undefined;
  if (value === "echo" || value === "http-json" || value === "npm-default-function" || value === "browser-screenshot" || value === "browser-operate" || value === "web-search" || value === "web-read" || value === "service-adapter" || value === "external-action-prepare" || value === "external-action-commit") return value;
  throw new Error("kind must be echo, http-json, npm-default-function, browser-screenshot, browser-operate, web-search, web-read, service-adapter, external-action-prepare, or external-action-commit");
}

function authoringMode(value: unknown): ToolBuilderRequest["authoringMode"] {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "llm" || value === "scaffold") return value;
  throw new Error("authoringMode must be auto, llm, or scaffold");
}

function startupMode(value: unknown): ToolStartupMode | undefined {
  if (value === undefined) return undefined;
  if (value === "on-demand" || value === "always-on" || value === "ephemeral") return value;
  throw new Error("startupMode must be on-demand, always-on, or ephemeral");
}

function implementationNotes(
  selected: ToolBuilderCandidate,
  adapterPackageName: string | undefined,
  adapterContract: ToolBuilderStrategyDecision["adapterContract"],
  integrationContract: ToolIntegrationContract | undefined,
): string[] {
  const integrationNotes = integrationContract
    ? [
        `Integration contract: ${integrationContract.mode}/${integrationContract.protocol}${integrationContract.provider ? `/${integrationContract.provider}` : ""}.`,
        "Secrets are referenced by handle in the manifest; raw credentials must stay in the secret store.",
      ]
    : [];
  if (selected.kind === "npm-package") {
    return [
      "Generated package owns npm dependencies inside its source-bundle workspace.",
      adapterContract
        ? `Adapter contract: ${adapterContract.evidence}`
        : `This first generic adapter expects ${adapterPackageName ?? "the selected package"} to expose a default callable export accepting (text, options).`,
      "If QA fails, the creation record keeps the package/build evidence instead of promoting the tool.",
      ...integrationNotes,
    ];
  }
  if (selected.kind === "external-api") {
    return [
      "Generated package exposes a small HTTP/JSON client shell.",
      "Future builder iterations should infer endpoint-specific schemas from docs/examples.",
      ...integrationNotes,
    ];
  }
  if (selected.kind === "container-service") {
    return [
      "Generated package is planned as an always-on service adapter with lifecycle, inbound events, and runtime callbacks.",
      "Provider details such as Telegram, Slack, or webhooks belong in the generated package, not Agentic core.",
      ...integrationNotes,
    ];
  }
  if (selected.kind === "web-search") {
    return [
      "Generated package exposes a portable web-search client with query/limit inputs.",
      "The deterministic scaffold tries a configurable JSON search endpoint first and falls back to DuckDuckGo HTML parsing.",
      "Future builder iterations should replace the fallback with provider-specific search adapters and stronger source QA when docs or credentials are supplied.",
      ...integrationNotes,
    ];
  }
  if (selected.kind === "web-read") {
    return [
      "Generated package exposes a portable web page reader with URL/focus inputs.",
      "The deterministic scaffold fetches HTML/text, extracts title, readable text, and links without adding dependencies to Agentic.",
      "Agents should use this when search snippets are too shallow and a known source URL needs deeper reading.",
      ...integrationNotes,
    ];
  }
  if (selected.kind === "browser-automation") {
    return [
      "Generated package uses Playwright-compatible browser automation isolated inside the source-bundle workspace.",
      "The package may return screenshot bytes as artifact-shaped evidence and can later run as an OCI container with Chromium installed.",
      "Interactive browser workflows run in prepare mode by default and must stop before final booking/payment/send/submit commit actions.",
      ...integrationNotes,
    ];
  }
  return [
    "Generated package uses the current deterministic TypeScript shell.",
    "Future builder iterations should replace this shell with LLM-authored source that satisfies the recorded QA contract.",
    ...integrationNotes,
  ];
}

function inferIntegrationContract(
  request: ToolBuilderRequest,
  selected: ToolBuilderCandidate,
): ToolIntegrationContract | undefined {
  const lower = [request.request, request.sourceTask, ...(request.capabilities ?? [])].join(" ").toLowerCase();
  if (selected.kind === "container-service" || /\b(bot|telegram|whatsapp|slack|discord|webhook|listener|incoming|inbound)\b/.test(lower)) {
    const provider = inferIntegrationProvider(lower);
    const secretHandle = provider === "telegram" ? "secret.telegram.bot" : provider ? `secret.${provider}.integration` : "secret.integration.token";
    return {
      schemaVersion: "agentic.tool-integration.v1",
      mode: "always-on-service",
      protocol: /\bwebhook\b/.test(lower) ? "webhook" : "messaging-bot",
      provider,
      auth: {
        type: provider === "telegram" || /\bbot\s+token\b/.test(lower) ? "bot-token" : "bearer-token",
        requiredSecretHandles: [secretHandle],
        notes: "Credential material is stored through this secret handle, not in prompts, memory, traces, or generated source.",
      },
      operations: [
        {
          name: "receive_inbound_event",
          direction: "inbound-event",
          description: "Receive provider events, normalize them, and create or continue normal Agentic runs.",
        },
        {
          name: "send_outbound_response",
          direction: "outbound-event",
          description: "Send completed run responses or status updates back through the provider.",
          requiredSecretHandles: [secretHandle],
        },
        {
          name: "service_lifecycle",
          direction: "lifecycle",
          description: "Start, stop, heartbeat, and report health through the generic tool service supervisor.",
        },
      ],
      inboundEventSchema: {
        type: "object",
        properties: {
          sourceChannelId: { type: "string" },
          sourceUserId: { type: "string" },
          sourceUserAliases: { type: "array", items: { type: "string" } },
          text: { type: "string" },
          attachments: { type: "array" },
        },
      },
      outboundEventSchema: {
        type: "object",
        properties: {
          targetChannelId: { type: "string" },
          targetUserId: { type: "string" },
          text: { type: "string" },
          artifactRefs: { type: "array" },
        },
      },
      callbackStrategy: "runtime-callbacks",
      notes: [
        "The generated service adapter should translate provider events into normal runs instead of adding provider branches to core.",
        "Long-running lifecycle belongs to ToolServiceSupervisor; Agentic sees the manifest, health, events, and callbacks.",
      ],
    };
  }
  if (selected.kind === "external-api" || /\b(api|endpoint|rest|graphql|openapi|curl)\b/.test(lower)) {
    return {
      schemaVersion: "agentic.tool-integration.v1",
      mode: "run-on-demand",
      protocol: "http-api",
      provider: inferIntegrationProvider(lower),
      auth: /\b(api\s*key|token|bearer|oauth|secret)\b/.test(lower)
        ? {
            type: /\bbearer\b/.test(lower) ? "bearer-token" : "api-key",
            requiredSecretHandles: ["secret.api.integration"],
            notes: "Operator must map the real API credential to this secret handle before live calls.",
          }
        : { type: "none" },
      operations: [
        {
          name: "call_api",
          direction: "outbound-request",
          description: "Call the documented API with operator/model-supplied parameters and return normalized content/data.",
        },
      ],
      callbackStrategy: "none",
      notes: [
        "OpenAPI/cURL/docs discovery should refine operations, schemas, auth, and QA examples before promotion.",
      ],
    };
  }
  return undefined;
}

function inferIntegrationProvider(lower: string): string | undefined {
  if (/\btelegram\b/.test(lower)) return "telegram";
  if (/\bwhatsapp\b/.test(lower)) return "whatsapp";
  if (/\bslack\b/.test(lower)) return "slack";
  if (/\bdiscord\b/.test(lower)) return "discord";
  return undefined;
}

function integrationContractRequiredSecretHandles(contract: ToolIntegrationContract | undefined): string[] {
  if (!contract) return [];
  return [
    ...(contract.auth?.requiredSecretHandles ?? []),
    ...contract.operations.flatMap((operation) => operation.requiredSecretHandles ?? []),
  ];
}

function integrationContractRequiredConfigurationKeys(contract: ToolIntegrationContract | undefined): string[] {
  if (!contract) return [];
  return [
    ...(contract.auth?.requiredConfigurationKeys ?? []),
    ...contract.operations.flatMap((operation) => operation.requiredConfigurationKeys ?? []),
  ];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function inferBehaviorExamples(
  request: ToolBuilderRequest,
  selected: ToolBuilderCandidate,
  adapterPackageName: string | undefined,
): ToolBehaviorExample[] {
  const textContext = [request.request, request.sourceTask].filter(Boolean).join("\n");
  const explicitExamples = inferExplicitIoExamples(textContext);
  if (explicitExamples.length > 0) return explicitExamples;
  if (selected.behaviorExamples?.length) return selected.behaviorExamples;
  if (selected.kind !== "npm-package" || !adapterPackageName) return [];
  const lower = [...(request.capabilities ?? []), request.request, request.sourceTask ?? ""].join(" ").toLowerCase();
  const textTransformExample = inferTextTransformExample(lower, textContext);
  if (textTransformExample) return [textTransformExample];
  if (/\b(slug|slugify|url-safe|url safe)\b/.test(lower)) {
    return [
      {
        title: "URL-safe slug transform",
        input: { text: "Hello Discovery Loop!", options: { lower: true } },
        expectedOk: true,
        expectedContent: "hello-discovery-loop!",
      },
    ];
  }
  return [];
}

function inferExplicitIoExamples(textContext: string): ToolBehaviorExample[] {
  const examples: ToolBehaviorExample[] = [];
  const patterns = [
    /(?:input|вход)\s*:?\s*(\{[\s\S]{1,800}?\}|["“][\s\S]{1,400}?["”])\s*(?:=>|->|→|—|-->|should return|returns?)\s*(?:(?:output|выход|результат)\s*:?)?\s*["“]?([^"”\n.]{1,400})["”]?/giu,
    /(?:output|выход|результат)\s*:?\s*["“]?([^"”\n.]{1,400})["”]?[\s\S]{0,120}(?:input|вход)\s*:?\s*(\{[\s\S]{1,800}?\}|["“][\s\S]{1,400}?["”])/giu,
  ];
  for (const pattern of patterns) {
    for (const match of textContext.matchAll(pattern)) {
      const first = String(match[1] ?? "").trim();
      const second = String(match[2] ?? "").trim();
      const inputRaw = pattern.source.startsWith("(?:output") ? second : first;
      const outputRaw = pattern.source.startsWith("(?:output") ? first : second;
      const input = parseExampleInput(inputRaw);
      const expectedContent = cleanExpectedOutput(outputRaw);
      if (input && expectedContent) {
        examples.push({
          title: "Request example behavior",
          input,
          expectedOk: true,
          expectedContent,
        });
      }
    }
  }
  return dedupeBehaviorExamples(examples).slice(0, 3);
}

function inferTextTransformExample(lowerContext: string, textContext: string): ToolBehaviorExample | undefined {
  const text = extractQuotedTextInput(textContext);
  if (!text) return undefined;
  const transform = inferTextTransformKind(lowerContext);
  if (!transform) return undefined;
  const expectedContent = applyTextTransformExample(text, transform);
  if (!expectedContent || expectedContent === text) return undefined;
  return {
    title: `${transform} transform from original task`,
    input: { text, options: {} },
    expectedOk: true,
    expectedContent,
  };
}

function inferTextTransformKind(lowerContext: string): "camelCase" | "slug" | "lowercase" | "uppercase" | "trim" | undefined {
  if (/\bcamel\s*case\b|\bcamelcase\b/.test(lowerContext)) return "camelCase";
  if (/\bslug|slugify|url-safe|url safe\b/.test(lowerContext)) return "slug";
  if (/\blower\s*case\b|\blowercase\b|нижн(?:ий|ему)\s+регистр/.test(lowerContext)) return "lowercase";
  if (/\bupper\s*case\b|\buppercase\b|верхн(?:ий|ему)\s+регистр/.test(lowerContext)) return "uppercase";
  if (/\btrim\b|remove surrounding whitespace|убери\s+пробел/.test(lowerContext)) return "trim";
  return undefined;
}

function applyTextTransformExample(text: string, transform: "camelCase" | "slug" | "lowercase" | "uppercase" | "trim"): string {
  if (transform === "camelCase") return toCamelCase(text);
  if (transform === "slug") return toSlug(text);
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "uppercase") return text.toUpperCase();
  return text.trim();
}

function extractQuotedTextInput(textContext: string): string | undefined {
  const preferred = [
    /(?:string|text|строк[ауи]?|текст)\s+["“]([^"”]{1,400})["”]/iu,
    /["“]([^"”]{1,400})["”]\s+(?:to|into|в)\s+(?:camel\s*case|camelcase|slug|url-safe|lowercase|uppercase|нижн|верхн)/iu,
  ];
  for (const pattern of preferred) {
    const match = textContext.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  const quoted = [...textContext.matchAll(/["“]([^"”]{1,400})["”]/gu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return quoted.find((value) => /\s/.test(value)) ?? quoted[0];
}

function toCamelCase(value: string): string {
  const words = value
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean);
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
  }).join("");
}

function toSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseExampleInput(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/g, "$1\"$2\":").replace(/'/g, "\"")) as Record<string, unknown>;
    } catch {
      const textMatch = trimmed.match(/(?:text|input|value)\s*:\s*["“']([^"”']+)["”']/iu);
      if (textMatch?.[1]) return { text: textMatch[1] };
      return undefined;
    }
  }
  const quoted = trimmed.match(/^["“]([\s\S]+)["”]$/u)?.[1]?.trim();
  return quoted ? { text: quoted } : { text: trimmed };
}

function cleanExpectedOutput(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^[`'“"]+|[`'”".,]+$/g, "")
    .trim();
  return cleaned || undefined;
}

function dedupeBehaviorExamples(examples: ToolBehaviorExample[]): ToolBehaviorExample[] {
  const seen = new Set<string>();
  const out: ToolBehaviorExample[] = [];
  for (const example of examples) {
    const key = JSON.stringify({ input: example.input, expectedContent: example.expectedContent });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(example);
  }
  return out;
}

function inferToolName(request: string): string {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, " ")
    .split(/\s+/)
    .filter((word) => /^[a-z0-9]+$/.test(word))
    .filter((word) => !["create", "make", "tool", "for", "the", "and", "with", "that"].includes(word))
    .slice(0, 4);
  return words.length > 0 ? words.join(".") : "custom.tool";
}

function inferDescription(request: string, strategyName: string): string {
  return `Generated ${strategyName} tool for: ${request.slice(0, 160)}`;
}

function inferCapabilities(request: string, strategy: ToolBuilderCandidate["kind"] | "external-action-prepare" | "external-action-commit"): string[] {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .slice(0, 3);
  const base = words.length > 0 ? words.join("-") : "generated-tool";
  return strategy === "npm-package"
    ? [base, "npm-package", "generated-tool"]
    : strategy === "external-api"
      ? [base, "api-client", "generated-tool"]
      : strategy === "web-search"
        ? [base, "web-search", "information-retrieval", "generated-tool"]
      : strategy === "web-read"
        ? [base, "web-read", "web-extract", "information-retrieval", "generated-tool"]
      : strategy === "browser-automation"
        ? browserAutomationCapabilities(request, base)
      : strategy === "external-action-prepare"
        ? [base, "external-action-prepare", "browser-automation", "browser-operate", "browser-field-candidates", "browser-form-schema", "dom-extraction", "artifact-image", "generated-tool"]
      : strategy === "external-action-commit"
        ? [base, "external-action-commit", "external-action-commit-generic", "generated-tool"]
        : [base, "generated-tool"];
}

function isExternalActionPrepareRequest(request: Pick<ToolBuilderRequest, "request" | "sourceTask" | "capabilities">): boolean {
  return /\bexternal-action-prepare\b|\bprepare external action\b|\bsafe external action preparation\b|\bprepared action draft\b|\bstop before final commit\b/.test([request.request, request.sourceTask, ...(request.capabilities ?? [])].join(" ").toLowerCase());
}

function isExternalActionCommitRequest(request: Pick<ToolBuilderRequest, "request" | "sourceTask" | "capabilities">): boolean {
  return /\bexternal-action-commit\b|\bcommit executor\b|\bapproved proposal commit\b|\bcommit approved external action\b/.test([request.request, request.sourceTask, ...(request.capabilities ?? [])].join(" ").toLowerCase());
}

function inferBrowserAutomationKind(request: ToolBuilderRequest): "browser-screenshot" | "browser-operate" {
  const lower = [request.request, request.sourceTask, ...(request.capabilities ?? [])].join(" ").toLowerCase();
  return /\b(browser[.\s_-]*operate|click|fill|type|select|submit|form|booking|reservation|appointment|prepare[-\s]?only|stop before commit|web automation)\b/.test(lower)
    ? "browser-operate"
    : "browser-screenshot";
}

function browserAutomationCapabilities(request: string, base: string): string[] {
  return /\b(browser[.\s_-]*operate|click|fill|type|select|submit|form|booking|reservation|appointment|prepare[-\s]?only|web automation)\b/i.test(request)
    ? [base, "browser-automation", "browser-operate", "dom-extraction", "artifact-image"]
    : [base, "browser-automation", "browser-screenshot", "artifact-image"];
}

function dependencyRecords(value: Record<string, string>): ToolCreationDependency[] {
  return Object.entries(value).map(([name, versionRange]) => ({ name, versionRange }));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const parsed = value.map((item, index) => text(item, `${field}[${index}]`));
  return parsed.length > 0 ? parsed : undefined;
}

function optionalSchema(value: unknown, field: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as ToolSchema;
}

function dependencyMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dependencies must be an object mapping package names to version ranges");
  }
  const out: Record<string, string> = {};
  for (const [name, rawRange] of Object.entries(value as Record<string, unknown>)) {
    const packageName = name.trim();
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) {
      throw new Error(`Invalid npm dependency name: ${name}`);
    }
    const versionRange = text(rawRange, `dependencies.${name}`);
    if (versionRange.includes("file:") || versionRange.includes("git+") || versionRange.includes("http:") || versionRange.includes("https:")) {
      throw new Error(`Dependency ${name} must use a registry version range, not a file/git/http reference`);
    }
    out[packageName] = versionRange;
  }
  return out;
}

function behaviorExamples(value: unknown): ToolBehaviorExample[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("behaviorExamples must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`behaviorExamples[${index}] must be an object`);
    }
    const example = item as Record<string, unknown>;
    const steps = behaviorSteps(example.steps, `behaviorExamples[${index}].steps`);
    if (!steps && (!example.input || typeof example.input !== "object" || Array.isArray(example.input))) {
      throw new Error(`behaviorExamples[${index}].input must be an object`);
    }
    return {
      title: optionalText(example.title, `behaviorExamples[${index}].title`),
      ...(example.input ? { input: example.input as Record<string, unknown> } : {}),
      ...(steps ? { steps } : {}),
      expectedOk: optionalBoolean(example.expectedOk, `behaviorExamples[${index}].expectedOk`),
      expectedContent: optionalText(example.expectedContent, `behaviorExamples[${index}].expectedContent`),
      expectedContentIncludes: optionalText(example.expectedContentIncludes, `behaviorExamples[${index}].expectedContentIncludes`),
      expectedDataPath: optionalText(example.expectedDataPath, `behaviorExamples[${index}].expectedDataPath`),
      ...(Object.prototype.hasOwnProperty.call(example, "expectedDataEquals") ? { expectedDataEquals: example.expectedDataEquals } : {}),
      expectedDataIncludes: optionalText(example.expectedDataIncludes, `behaviorExamples[${index}].expectedDataIncludes`),
      expectedArtifactMimeType: optionalText(example.expectedArtifactMimeType, `behaviorExamples[${index}].expectedArtifactMimeType`),
      expectedArtifactVisualOk: optionalBoolean(example.expectedArtifactVisualOk, `behaviorExamples[${index}].expectedArtifactVisualOk`),
    };
  });
}

function behaviorSteps(value: unknown, field: string): ToolBehaviorExample["steps"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    const step = item as Record<string, unknown>;
    if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) {
      throw new Error(`${field}[${index}].input must be an object`);
    }
    const title = optionalText(step.title, `${field}[${index}].title`);
    const saveAs = optionalText(step.saveAs, `${field}[${index}].saveAs`);
    const expectedOk = optionalBoolean(step.expectedOk, `${field}[${index}].expectedOk`);
    const expectedContent = optionalText(step.expectedContent, `${field}[${index}].expectedContent`);
    const expectedContentIncludes = optionalText(step.expectedContentIncludes, `${field}[${index}].expectedContentIncludes`);
    const expectedDataPath = optionalText(step.expectedDataPath, `${field}[${index}].expectedDataPath`);
    const expectedDataIncludes = optionalText(step.expectedDataIncludes, `${field}[${index}].expectedDataIncludes`);
    const expectedArtifactMimeType = optionalText(step.expectedArtifactMimeType, `${field}[${index}].expectedArtifactMimeType`);
    const expectedArtifactVisualOk = optionalBoolean(step.expectedArtifactVisualOk, `${field}[${index}].expectedArtifactVisualOk`);
    return {
      ...(title !== undefined ? { title } : {}),
      input: step.input as Record<string, unknown>,
      ...(saveAs !== undefined ? { saveAs } : {}),
      ...(expectedOk !== undefined ? { expectedOk } : {}),
      ...(expectedContent !== undefined ? { expectedContent } : {}),
      ...(expectedContentIncludes !== undefined ? { expectedContentIncludes } : {}),
      ...(expectedDataPath !== undefined ? { expectedDataPath } : {}),
      ...(Object.prototype.hasOwnProperty.call(step, "expectedDataEquals") ? { expectedDataEquals: step.expectedDataEquals } : {}),
      ...(expectedDataIncludes !== undefined ? { expectedDataIncludes } : {}),
      ...(expectedArtifactMimeType !== undefined ? { expectedArtifactMimeType } : {}),
      ...(expectedArtifactVisualOk !== undefined ? { expectedArtifactVisualOk } : {}),
    };
  });
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
