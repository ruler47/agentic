import type { ToolBuildAttemptContext } from "./toolBuildWorkflow.js";
import type { ToolBuildRequest } from "./toolBuildRequestStore.js";
import type { ToolStartupMode } from "./tool.js";

export type ToolBuildBlueprintKind = "api" | "service" | "artifact" | "browser" | "data" | "generic";

export type ToolBuildBlueprintOperation = {
  id: string;
  name: string;
  method?: string;
  url?: string;
  path?: string;
  description: string;
  requestFields: string[];
  responseFields: string[];
  authHeaders: string[];
};

export type ToolBuildBlueprintFixture = {
  name: string;
  source: "json-block" | "curl" | "request-contract" | "repair-context";
  input?: unknown;
  expectedOutput?: unknown;
  text?: string;
};

export type ToolBuildBlueprint = {
  kind: ToolBuildBlueprintKind;
  summary: string;
  documentation: {
    urls: string[];
    inlineSnippets: string[];
    sourceFields: string[];
  };
  operations: ToolBuildBlueprintOperation[];
  fixtures: ToolBuildBlueprintFixture[];
  credentials: {
    handles: string[];
    rawCredentialMentioned: boolean;
    rawSecretCandidates: string[];
    authHeaders: string[];
    authSchemes: string[];
  };
  runtime: {
    startupMode: ToolStartupMode;
    settingsKeys: string[];
    storageRequired: boolean;
    lifecycle: string[];
  };
  constraints: string[];
  repair?: {
    attempt: number;
    previousSummary: string;
    previousChecks: string[];
  };
};

type TextPart = {
  field: string;
  value: string;
};

export function createToolBuildBlueprint(
  request: ToolBuildRequest,
  context?: ToolBuildAttemptContext,
): ToolBuildBlueprint {
  const parts = collectTextParts(request, context);
  const text = parts.map((part) => part.value).join("\n\n");
  const integration = request.contract.integration;
  const urls = unique([...extractUrls(text), ...(integration?.notes.flatMap(extractUrls) ?? [])]);
  const snippets = extractInlineSnippets(parts);
  const rawSecretCandidates = extractRawSecretCandidates(request);
  const authHeaders = unique([
    ...extractAuthHeaders(text),
    ...rawSecretCandidates.flatMap((candidate) => extractAuthHeaders(candidate)),
  ]);
  const operations = extractOperations(text, request, authHeaders);
  const fixtures = extractFixtures(text, request, context);
  const responseFields = unique([
    ...(request.requiredOutputs ?? []),
    ...operations.flatMap((operation) => operation.responseFields),
    ...extractFieldReferences(text),
  ]);

  const kind = inferBlueprintKind(request, text);
  const startupMode = request.contract.startupMode;
  const settingsKeys = unique([
    ...(integration?.settings.map((setting) => setting.key) ?? []),
    ...inferSettingKeys(text),
  ]);
  const storageRequired = /\b(database|postgres|sqlite|store|persist|migration|cache|state)\b/i.test(text);

  const normalizedOperations = operations.length
    ? operations.map((operation) => ({
        ...operation,
        responseFields: unique([...operation.responseFields, ...responseFields]).slice(0, 16),
      }))
    : [];

  return {
    kind,
    summary: summarizeRequest(request),
    documentation: {
      urls,
      inlineSnippets: snippets,
      sourceFields: parts.map((part) => part.field),
    },
    operations: normalizedOperations,
    fixtures,
    credentials: {
      handles: unique([...(request.credentialHandles ?? []), ...(integration?.credentials.handles ?? [])]),
      rawCredentialMentioned: rawSecretCandidates.length > 0 || Boolean(request.credentialNotes?.trim()),
      rawSecretCandidates,
      authHeaders,
      authSchemes: extractAuthSchemes(text),
    },
    runtime: {
      startupMode,
      settingsKeys,
      storageRequired,
      lifecycle: inferLifecycle(request, text),
    },
    constraints: inferConstraints(request, text),
    repair: context?.previousQaReport
      ? {
          attempt: context.attempt,
          previousSummary: context.previousQaReport.summary,
          previousChecks: context.previousQaReport.checks,
        }
      : undefined,
  };
}

export function blueprintToPromptSection(blueprint: ToolBuildBlueprint): string {
  return [
    "Tool Build Blueprint (source of truth for this build):",
    JSON.stringify(blueprint, null, 2),
    "",
    "Builder obligations:",
    "- Implement documented operations/endpoints from the blueprint when present.",
    "- Use only declared secret handles; never copy raw credential candidates into source, tests, docs, traces, logs, or examples.",
    "- Generate tests that exercise blueprint fixtures or equivalent documented examples.",
    "- If this is a repair attempt, explicitly address previous QA checks in changeSummary and tests.",
    "- Keep the module portable: depend on the Tool contract, runtime context, settings, and secret handles, not Agentic internals.",
  ].join("\n");
}

/**
 * Phase 13 — when the agent attached a structured improvement spec
 * to a rebuild request, format it into a dedicated prompt section
 * that the builder LLM can act on directly. Returns an empty
 * string when no spec is attached.
 */
export function improvementSpecToPromptSection(spec: ToolBuildRequest["improvementSpec"]): string {
  if (!spec) return "";
  const lines = [
    "Improvement Spec (structured request from the agent that hit the failure):",
    `- Symptom: ${spec.symptom}`,
    `- Expected behavior: ${spec.expectedBehavior}`,
  ];
  if (spec.failureExamples?.length) {
    lines.push("- Failure examples:");
    for (const ex of spec.failureExamples) {
      lines.push(
        `  • run ${ex.runId}` +
          (ex.artifactIds?.length ? ` (artifacts: ${ex.artifactIds.join(", ")})` : "") +
          (ex.notes ? ` — ${ex.notes}` : ""),
      );
    }
  }
  if (spec.acceptanceTest) {
    lines.push(`- Acceptance test: ${spec.acceptanceTest}`);
  }
  lines.push(
    "",
    "Builder must:",
    "- Address the symptom directly in the new version.",
    "- Add a regression test that covers the failure example(s) (or a closest reproducible analog).",
    "- Document the fix in changeSummary so promotion review can see what changed.",
  );
  return lines.join("\n");
}

export function validateToolBuilderResponseAgainstBlueprint(
  output: {
    docsMarkdown?: string;
    examples?: unknown;
    operations?: unknown;
    qaFixtures?: unknown;
    files: Array<{ path: string; content: string }>;
    packageManifest?: unknown;
  },
  blueprint: ToolBuildBlueprint,
): void {
  const searchable = [
    output.docsMarkdown,
    JSON.stringify(output.examples ?? ""),
    JSON.stringify(output.operations ?? ""),
    JSON.stringify(output.qaFixtures ?? ""),
    JSON.stringify(output.packageManifest ?? ""),
    ...output.files.map((file) => `${file.path}\n${file.content}`),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n\n");

  for (const secret of blueprint.credentials.rawSecretCandidates) {
    if (secret.length >= 8 && searchable.includes(secret)) {
      throw new Error("LLM Tool Builder output leaked raw credential material from the request.");
    }
  }

  for (const handle of blueprint.credentials.handles) {
    if (handle && !searchable.includes(handle)) {
      throw new Error(`LLM Tool Builder output did not declare required secret handle ${handle}.`);
    }
  }

  if (blueprint.operations.length > 0) {
    const matched = blueprint.operations.some((operation) =>
      [operation.method, operation.url, operation.path]
        .filter((value): value is string => Boolean(value))
        .some((value) => searchable.toLowerCase().includes(value.toLowerCase())),
    );
    if (!matched) {
      throw new Error("LLM Tool Builder output ignored the documented operation from the build blueprint.");
    }
  }

  if (blueprint.fixtures.length > 0) {
    const matched = blueprint.fixtures.some((fixture) =>
      [fixture.name, fixture.text, JSON.stringify(fixture.input ?? ""), JSON.stringify(fixture.expectedOutput ?? "")]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.length >= 4 && searchable.toLowerCase().includes(value.toLowerCase().slice(0, 120))),
    );
    if (!matched) {
      throw new Error("LLM Tool Builder output did not cover any documented blueprint fixture.");
    }
  }

  if (blueprint.runtime.startupMode === "always-on") {
    const hasLifecycle = /startService|startupMode["']?\s*:\s*["']always-on|always-on/i.test(searchable);
    if (!hasLifecycle) {
      throw new Error("LLM Tool Builder output must implement always-on lifecycle behavior from the blueprint.");
    }
  }
}

export function extractRawSecretCandidates(request: ToolBuildRequest): string[] {
  const text = [request.credentialNotes, request.reason, request.taskSummary, request.feedback]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const candidates = new Set<string>();
  const patterns = [
    /\b(?:api[\s_-]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*["']?([A-Za-z0-9_.:-]{8,})["']?/gi,
    /\bBearer\s+([A-Za-z0-9_.:-]{12,})\b/gi,
    /\b([0-9]{8,}:[A-Za-z0-9_-]{20,})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value && !value.startsWith("secret.")) candidates.add(value);
    }
  }
  return [...candidates];
}

function collectTextParts(request: ToolBuildRequest, context?: ToolBuildAttemptContext): TextPart[] {
  const parts: TextPart[] = [
    { field: "capability", value: request.capability },
    { field: "displayName", value: request.displayName ?? "" },
    { field: "reason", value: request.reason },
    { field: "taskSummary", value: request.taskSummary ?? "" },
    { field: "requiredInputs", value: (request.requiredInputs ?? []).join("\n") },
    { field: "requiredOutputs", value: (request.requiredOutputs ?? []).join("\n") },
    { field: "qaCriteria", value: (request.qaCriteria ?? []).join("\n") },
    { field: "credentialNotes", value: request.credentialNotes ?? "" },
    { field: "feedback", value: request.feedback ?? "" },
    { field: "builderInstructions", value: request.contract.builderInstructions.join("\n") },
    { field: "integrationNotes", value: request.contract.integration?.notes.join("\n") ?? "" },
  ];
  if (context?.previousQaReport) {
    parts.push({ field: "previousQaSummary", value: context.previousQaReport.summary });
    parts.push({ field: "previousQaChecks", value: context.previousQaReport.checks.join("\n") });
  }
  return parts.filter((part) => part.value.trim());
}

function summarizeRequest(request: ToolBuildRequest): string {
  return [
    request.displayName ?? request.contract.displayName ?? request.contract.toolName,
    request.reason,
    request.taskSummary,
  ]
    .filter(Boolean)
    .join(" - ")
    .slice(0, 700);
}

function extractUrls(text: string): string[] {
  return unique(
    [...text.matchAll(/https?:\/\/[^\s`'"<>)]+/gi)]
      .map((match) => match[0].replace(/[),.;]+$/g, ""))
      .filter(Boolean),
  );
}

function extractInlineSnippets(parts: TextPart[]): string[] {
  return parts
    .filter((part) => /docs|documentation|openapi|swagger|curl|endpoint|response|request|api/i.test(part.value))
    .map((part) => `${part.field}: ${part.value}`)
    .join("\n\n")
    .split(/\n{3,}/)
    .map((snippet) => snippet.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function extractOperations(
  text: string,
  request: ToolBuildRequest,
  authHeaders: string[],
): ToolBuildBlueprintOperation[] {
  const operations: ToolBuildBlueprintOperation[] = [];
  for (const match of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(`?)(https?:\/\/[^\s`'")]+|\/[A-Za-z0-9_./:{}?=&%-]+)\2/gi)) {
    const method = match[1]?.toUpperCase();
    const target = match[3]?.replace(/[),.;]+$/g, "");
    if (!method || !target) continue;
    operations.push(createOperation(method, target, request, authHeaders, text));
  }

  for (const curl of text.matchAll(/curl\s+([\s\S]*?)(?=\n\s*\n|$)/gi)) {
    const block = curl[0];
    const method = block.match(/(?:-X|--request)\s+["']?([A-Z]+)["']?/i)?.[1]?.toUpperCase() ?? inferCurlMethod(block);
    const target = block.match(/https?:\/\/[^\s'"\\]+/)?.[0]?.replace(/[),.;]+$/g, "");
    if (!target) continue;
    operations.push(createOperation(method, target, request, unique([...authHeaders, ...extractAuthHeaders(block)]), block));
  }

  return dedupeOperations(operations).slice(0, 12);
}

function createOperation(
  method: string,
  target: string,
  request: ToolBuildRequest,
  authHeaders: string[],
  sourceText: string,
): ToolBuildBlueprintOperation {
  const isUrl = /^https?:\/\//i.test(target);
  const path = isUrl ? new URL(target).pathname : target.split("?")[0] ?? target;
  const id = `${method.toLowerCase()}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "operation"}`;
  return {
    id,
    name: `${method} ${path}`,
    method,
    url: isUrl ? target : undefined,
    path: isUrl ? path : target,
    description: `Documented operation for ${request.capability}.`,
    requestFields: unique([...(request.requiredInputs ?? []), ...extractPathParams(target), ...extractRequestFields(sourceText)]).slice(0, 20),
    responseFields: unique([...(request.requiredOutputs ?? []), ...extractFieldReferences(sourceText)]).slice(0, 20),
    authHeaders,
  };
}

function inferCurlMethod(block: string): string {
  if (/(?:-d|--data|--json)\b/i.test(block)) return "POST";
  return "GET";
}

function dedupeOperations(operations: ToolBuildBlueprintOperation[]): ToolBuildBlueprintOperation[] {
  const byKey = new Map<string, ToolBuildBlueprintOperation>();
  for (const operation of operations) {
    const key = `${operation.method}:${operation.url ?? operation.path}`;
    if (!byKey.has(key)) byKey.set(key, operation);
  }
  return [...byKey.values()];
}

function extractPathParams(target: string): string[] {
  return unique([
    ...[...target.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? ""),
    ...[...target.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? ""),
  ].filter(Boolean));
}

function extractRequestFields(text: string): string[] {
  return unique([
    ...[...text.matchAll(/\b(?:input|request|body|payload|params?|query)\s*[:=]\s*([A-Za-z0-9_.\[\], -]+)/gi)]
      .flatMap((match) => (match[1] ?? "").split(/[, ]+/)),
    ...[...text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*(?:Id|ID|Hash|Address|Token|Query|Url|URL))\b/g)].map(
      (match) => match[1] ?? "",
    ),
  ].filter((value) => value.length > 1));
}

function extractFieldReferences(text: string): string[] {
  const fields = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)*)`/g)) {
    fields.add(match[1] ?? "");
  }
  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*(?:\[\])?\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)*)\b/g)) {
    fields.add(match[1] ?? "");
  }
  for (const match of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{2,})"\s*:/g)) {
    fields.add(match[1] ?? "");
  }
  return [...fields].filter((field) => !/^https?:/i.test(field)).slice(0, 32);
}

function extractFixtures(
  text: string,
  request: ToolBuildRequest,
  context?: ToolBuildAttemptContext,
): ToolBuildBlueprintFixture[] {
  const fixtures: ToolBuildBlueprintFixture[] = [];
  let jsonIndex = 0;
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      fixtures.push({
        name: `json-fixture-${++jsonIndex}`,
        source: "json-block",
        expectedOutput: parsed,
        text: raw.slice(0, 1000),
      });
    } catch {
      // Non-JSON fenced examples still help the prompt but are not strict fixtures.
    }
  }
  if ((request.requiredInputs?.length ?? 0) > 0 || (request.requiredOutputs?.length ?? 0) > 0) {
    fixtures.push({
      name: "request-contract-fixture",
      source: "request-contract",
      input: Object.fromEntries((request.requiredInputs ?? []).map((field) => [field, `<${field}>`])),
      expectedOutput: Object.fromEntries((request.requiredOutputs ?? []).map((field) => [field, `<${field}>`])),
    });
  }
  if (context?.previousQaReport) {
    fixtures.push({
      name: "previous-qa-regression",
      source: "repair-context",
      text: [context.previousQaReport.summary, ...context.previousQaReport.checks].join("\n").slice(0, 1200),
    });
  }
  return fixtures.slice(0, 10);
}

function extractAuthHeaders(text: string): string[] {
  const headers = new Set<string>();
  const headerPattern = /\b([A-Za-z][A-Za-z0-9-]*(?:api[-_]?key|authorization|token|secret|key)[A-Za-z0-9-]*)\s*:/gi;
  for (const match of text.matchAll(headerPattern)) headers.add((match[1] ?? "").toLowerCase());
  if (/\bx-api-key\b/i.test(text)) headers.add("x-api-key");
  if (/\bauthorization\b|\bbearer\b/i.test(text)) headers.add("authorization");
  return [...headers].filter(Boolean);
}

function extractAuthSchemes(text: string): string[] {
  const schemes = new Set<string>();
  if (/\bbearer\b/i.test(text)) schemes.add("bearer");
  if (/\bx-api-key\b|\bapi[-\s]?key\b/i.test(text)) schemes.add("api-key");
  if (/\boauth\b/i.test(text)) schemes.add("oauth");
  return [...schemes];
}

function inferSettingKeys(text: string): string[] {
  const keys = new Set<string>();
  if (/\bbase\s*url|baseURL|endpoint\b/i.test(text)) keys.add("baseUrl");
  if (/\brate\s*limit|rpm|requests per minute\b/i.test(text)) keys.add("rateLimit");
  if (/\btimeout\b/i.test(text)) keys.add("timeoutMs");
  if (/\bwebhook\b|webhookPath/i.test(text)) keys.add("webhookPath");
  if (/\ballowlist|whitelist|allowed\b/i.test(text)) keys.add("allowedIdentities");
  return [...keys];
}

function inferBlueprintKind(request: ToolBuildRequest, text: string): ToolBuildBlueprintKind {
  if (request.contract.startupMode === "always-on") {
    return "service";
  }
  if (request.contract.integration?.mode === "on-demand-api" || /\bapi|endpoint|openapi|swagger|https?:\/\/|curl\b/i.test(text)) return "api";
  if (/\b(bot|webhook|polling|listener|service|daemon)\b/i.test(text)) return "service";
  if (/\bbrowser|screenshot|playwright|page\b/i.test(text)) return "browser";
  if (/\bpdf|document|image|chart|artifact|file\b/i.test(text)) return "artifact";
  if (/\btime[-\s]?series|dataset|csv|table|analytics|score\b/i.test(text)) return "data";
  return "generic";
}

function inferLifecycle(request: ToolBuildRequest, text: string): string[] {
  const lifecycle = new Set<string>([
    "healthcheck before promotion",
    "structured ToolResult failures for expected bad inputs",
  ]);
  if (request.contract.startupMode === "always-on") {
    lifecycle.add("startService under supervisor");
    lifecycle.add("stop/restart support");
    lifecycle.add("neutral inbound/outbound events when provider events exist");
  }
  if (/\bwebhook\b/i.test(text)) lifecycle.add("webhook verification and replay-safe handling");
  if (/\bpolling|poller\b/i.test(text)) lifecycle.add("polling checkpoint/state handling");
  return [...lifecycle];
}

function inferConstraints(request: ToolBuildRequest, text: string): string[] {
  return unique([
    "TypeScript only.",
    "No raw secrets in source, tests, docs, logs, traces, memory, or artifacts.",
    "Use the standard Tool contract and runtime context.",
    "Do not import Agentic private runtime internals.",
    "Tests must cover success, invalid input, and at least one failure path.",
    ...(request.contract.integration
      ? ["Provider-specific APIs must be hidden behind the neutral Tool Integration contract."]
      : []),
    ...(/\bdelete|destructive|write|transfer|send\b/i.test(text)
      ? ["Potentially destructive/outbound actions must be explicit and auditable."]
      : []),
  ]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}
