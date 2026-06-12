import type {
  ToolAdapterContract,
  ToolBehaviorExample,
  ToolBuilderCandidate,
  ToolBuilderDiscoveryEvidence,
} from "./toolCreationStore.js";
import { fetchDocumentationPages } from "./toolImplementationDocsCrawler.js";
import { inferCurlBehaviorExamples, inferCurlIntegrationContract } from "./toolImplementationDiscoveryCurl.js";
import { inferHtmlDocsBehaviorExamples, inferHtmlDocsIntegrationContract } from "./toolImplementationDiscoveryHtmlDocs.js";
import { inferOpenApiBehaviorExamples, inferOpenApiIntegrationContract } from "./toolImplementationDiscoveryOpenApi.js";
import {
  dedupeBehaviorExamples,
  inferAdapterContractFromReadme,
  inferBehaviorExamplesFromReadme,
  summarizeNpmPackageMetadata,
} from "./toolImplementationDiscoveryNpmReadme.js";

export type ToolImplementationDiscoveryMode = "disabled" | "npm" | "auto";

export type ToolImplementationDiscoveryResult = {
  mode: ToolImplementationDiscoveryMode;
  candidates: ToolBuilderCandidate[];
  dependencies: Record<string, string>;
  evidence: ToolBuilderDiscoveryEvidence[];
  notes: string[];
};

type FetchLike = typeof fetch;

type NpmSearchResponse = {
  objects?: Array<{
    package?: {
      name?: unknown;
      version?: unknown;
      description?: unknown;
      links?: { npm?: unknown; homepage?: unknown; repository?: unknown };
    };
    score?: { final?: unknown };
  }>;
};

type NpmPackageMetadataResponse = {
  name?: unknown;
  description?: unknown;
  readme?: unknown;
  keywords?: unknown;
  "dist-tags"?: { latest?: unknown };
  versions?: Record<string, {
    main?: unknown;
    types?: unknown;
    module?: unknown;
    exports?: unknown;
  }>;
};

type DiscoveryRequest = {
  request: string;
  capabilities?: string[];
  query?: string;
  mode?: ToolImplementationDiscoveryMode;
  hasExplicitDependencies: boolean;
  legacyKind: boolean;
  docsText?: string;
  docsUrls: string[];
};

export async function discoverToolImplementation(options: {
  rawInput: unknown;
  fetchImpl?: FetchLike;
  registryBaseUrl?: string;
  timeoutMs?: number;
}): Promise<ToolImplementationDiscoveryResult> {
  const request = parseDiscoveryRequest(options.rawInput);
  const mode = request.mode ?? discoveryModeFromEnv();
  if (mode === "disabled") {
    const docsDiscovery = await inspectProvidedDocumentation(request, options.fetchImpl ?? fetch, undefined);
    return docsDiscovery ?? emptyDiscovery("disabled", "Implementation discovery is disabled.");
  }
  const docsController = new AbortController();
  const docsTimeout = setTimeout(() => docsController.abort(), Math.max(1_000, options.timeoutMs ?? 5_000));
  try {
    const docsDiscovery = await inspectProvidedDocumentation(request, options.fetchImpl ?? fetch, docsController.signal);
    if (docsDiscovery) return docsDiscovery;
  } finally {
    clearTimeout(docsTimeout);
  }
  if (request.hasExplicitDependencies) {
    return emptyDiscovery(mode, "Explicit dependencies were supplied by the operator; discovery did not override them.");
  }
  if (request.legacyKind) {
    return emptyDiscovery(mode, "Legacy kind was supplied; discovery did not override compatibility behavior.");
  }

  const query = request.query ?? buildNpmSearchQuery(request.request, request.capabilities);
  if (!query) return emptyDiscovery(mode, "No useful npm search query could be inferred.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? 5_000));
  try {
    const baseUrl = (options.registryBaseUrl ?? process.env.TOOL_BUILDER_NPM_REGISTRY_SEARCH_URL ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    const url = `${baseUrl}/-/v1/search?text=${encodeURIComponent(query)}&size=5`;
    const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      return emptyDiscovery(mode, `npm registry search failed with HTTP ${response.status}.`, {
        provider: "npm-registry",
        query,
        summary: body.slice(0, 500) || `HTTP ${response.status}`,
        url,
      });
    }
    const parsed = JSON.parse(body) as NpmSearchResponse;
    const candidates = parseNpmCandidates(parsed, query);
    if (candidates.length === 0) {
      return emptyDiscovery(mode, "npm registry search returned no usable package candidates.", {
        provider: "npm-registry",
        query,
        summary: "No usable package candidates.",
        url,
      });
    }
    const selected = candidates[0];
    const packageName = selected.packageName;
    const versionRange = selected.versionRange;
    const inspection = packageName
      ? await inspectNpmPackageMetadata({
          baseUrl,
          packageName,
          packageVersion: versionRange?.replace(/^\^/, ""),
          fetchImpl: options.fetchImpl ?? fetch,
          signal: controller.signal,
        })
      : undefined;
    const inspectedCandidates = inspection?.summary
      ? [
          {
            ...selected,
            inspectionSummary: inspection.summary,
            adapterContract: inspection.adapterContract,
            behaviorExamples: inspection.behaviorExamples,
            reason: `${selected.reason} Inspection: ${inspection.summary}`,
          },
          ...candidates.slice(1),
        ]
      : candidates;
    const dependencies = packageName && versionRange ? { [packageName]: versionRange } : {};
    return {
      mode,
      candidates: inspectedCandidates,
      dependencies,
      evidence: [
        {
          provider: "npm-registry",
          query,
          summary: `Selected ${packageName ?? selected.name} from npm registry search.`,
          packageName,
          packageVersion: versionRange?.replace(/^\^/, ""),
          url,
        },
        ...(inspection?.evidence ? [inspection.evidence] : []),
      ],
      notes: [
        `npm discovery query: ${query}`,
        `Selected candidate: ${selected.name}`,
        ...(inspection?.summary ? [`Package inspection: ${inspection.summary}`] : []),
      ],
    };
  } catch (error) {
    return emptyDiscovery(mode, `npm discovery failed: ${error instanceof Error ? error.message : "unknown error"}`, {
      provider: "npm-registry",
      query,
      summary: "npm discovery failed before a candidate could be selected.",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectNpmPackageMetadata(options: {
  baseUrl: string;
  packageName: string;
  packageVersion?: string;
  fetchImpl: FetchLike;
  signal: AbortSignal;
}): Promise<{
  summary: string;
  evidence: ToolBuilderDiscoveryEvidence;
  adapterContract?: ToolAdapterContract;
  behaviorExamples?: ToolBehaviorExample[];
} | undefined> {
  const url = `${options.baseUrl}/${encodeURIComponent(options.packageName)}`;
  try {
    const response = await options.fetchImpl(url, { signal: options.signal });
    const body = await response.text();
    if (!response.ok) {
      return {
        summary: `Package metadata lookup failed with HTTP ${response.status}.`,
        evidence: {
          provider: "npm-package-metadata",
          summary: `Metadata lookup for ${options.packageName} failed with HTTP ${response.status}.`,
          packageName: options.packageName,
          packageVersion: options.packageVersion,
          url,
        },
      };
    }
    const metadata = JSON.parse(body) as NpmPackageMetadataResponse;
    const adapterContract = inferAdapterContractFromReadme(
      typeof metadata.readme === "string" ? metadata.readme : "",
      options.packageName,
    );
    const behaviorExamples = inferBehaviorExamplesFromReadme(
      typeof metadata.readme === "string" ? metadata.readme : "",
      options.packageName,
      adapterContract,
    );
    const summary = summarizeNpmPackageMetadata(metadata, options.packageName, options.packageVersion, adapterContract, behaviorExamples);
    return {
      summary,
      adapterContract,
      behaviorExamples,
      evidence: {
        provider: "npm-package-metadata",
        summary,
        packageName: options.packageName,
        packageVersion: options.packageVersion,
        url,
        behaviorExamples,
      },
    };
  } catch (error) {
    const summary = `Package metadata lookup failed: ${error instanceof Error ? error.message : "unknown error"}.`;
    return {
      summary,
      evidence: {
        provider: "npm-package-metadata",
        summary,
        packageName: options.packageName,
        packageVersion: options.packageVersion,
        url,
      },
    };
  }
}

async function inspectProvidedDocumentation(
  request: DiscoveryRequest,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
): Promise<ToolImplementationDiscoveryResult | undefined> {
  const docs = [
    request.docsText,
    ...(await fetchDocumentationPages({ urls: request.docsUrls, fetchImpl, signal })).map((page) => page.text),
  ].filter((value): value is string => Boolean(value?.trim()));
  if (docs.length === 0) return undefined;

  const combined = docs.join("\n\n---\n\n").slice(0, 250_000);
  const openApiExamples = inferOpenApiBehaviorExamples(combined);
  const curlExamples = inferCurlBehaviorExamples(combined);
  const htmlDocsExamples = inferHtmlDocsBehaviorExamples(combined);
  const integrationContract = inferOpenApiIntegrationContract(combined)
    ?? inferCurlIntegrationContract(combined)
    ?? inferHtmlDocsIntegrationContract(combined);
  const behaviorExamples = dedupeBehaviorExamples([...openApiExamples, ...curlExamples, ...htmlDocsExamples]).slice(0, 5);
  const evidence: ToolBuilderDiscoveryEvidence[] = [
    {
      provider: "operator-docs",
      summary: `Operator documentation inspected (${docs.length} source${docs.length === 1 ? "" : "s"}).`,
      behaviorExamples: behaviorExamples.length ? behaviorExamples : undefined,
    },
  ];
  if (openApiExamples.length) {
    evidence.push({
      provider: "openapi",
      summary: `OpenAPI documentation yielded ${openApiExamples.length} behavior fixture(s).`,
      behaviorExamples: openApiExamples,
    });
  }
  if (curlExamples.length) {
    evidence.push({
      provider: "curl",
      summary: `cURL examples yielded ${curlExamples.length} behavior fixture(s).`,
      behaviorExamples: curlExamples,
    });
  }
  if (htmlDocsExamples.length) {
    evidence.push({
      provider: "html-docs",
      summary: `HTML/API docs yielded ${htmlDocsExamples.length} behavior fixture(s).`,
      behaviorExamples: htmlDocsExamples,
    });
  }
  if (behaviorExamples.length === 0) {
    if (integrationContract) {
      return {
        mode: request.mode ?? discoveryModeFromEnv(),
        candidates: [
          {
            kind: "external-api",
            name: "documentation-derived API contract",
            reason: "Operator documentation yielded an API integration contract but no executable live behavior QA fixture.",
            integrationContract,
            inspectionSummary: "Docs-derived integration contract requires manual or LLM-authored behavior QA.",
          },
        ],
        dependencies: {},
        evidence,
        notes: [
          "Operator documentation yielded an integration contract, but executable behavior fixtures need concrete URLs, required path/query values, and expected response signals.",
        ],
      };
    }
    return {
      mode: request.mode ?? discoveryModeFromEnv(),
      candidates: [],
      dependencies: {},
      evidence,
      notes: ["Operator documentation was supplied but no executable behavior fixtures could be inferred."],
    };
  }
  return {
    mode: request.mode ?? discoveryModeFromEnv(),
    candidates: [
      {
        kind: "external-api",
        name: "documentation-derived API contract",
        reason: `Operator documentation yielded ${behaviorExamples.length} behavior QA fixture(s).`,
        behaviorExamples,
        integrationContract,
        inspectionSummary: `Docs-derived behavior fixtures: ${behaviorExamples.length}.`,
      },
    ],
    dependencies: {},
    evidence,
    notes: [
      `Documentation discovery inferred ${behaviorExamples.length} behavior QA fixture(s).`,
      "These fixtures run before registration and can block scaffolded tools that do not satisfy documented API behavior.",
    ],
  };
}

function parseNpmCandidates(response: NpmSearchResponse, query: string): ToolBuilderCandidate[] {
  const candidates: ToolBuilderCandidate[] = [];
  for (const item of response.objects ?? []) {
    const name = typeof item.package?.name === "string" ? item.package.name.trim() : "";
    const version = typeof item.package?.version === "string" ? item.package.version.trim() : "";
    if (!isSafePackageName(name) || !isSemver(version)) continue;
    const description = typeof item.package?.description === "string" ? item.package.description.trim() : "";
    const score = typeof item.score?.final === "number" ? item.score.final : undefined;
    candidates.push({
      kind: "npm-package",
      name,
      packageName: name,
      versionRange: `^${version}`,
      reason: [
        `npm registry candidate for query "${query}".`,
        description ? `Description: ${description.slice(0, 180)}` : undefined,
        typeof score === "number" ? `Search score: ${score.toFixed(3)}.` : undefined,
      ].filter(Boolean).join(" "),
    });
  }
  return candidates.slice(0, 5);
}

function parseDiscoveryRequest(rawInput: unknown): DiscoveryRequest {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("tool discovery request must be an object");
  }
  const body = rawInput as Record<string, unknown>;
  const request = text(body.request ?? body.desiredBehavior ?? body.task, "request");
  const docsText = collectDocumentationText(body);
  return {
    request,
    capabilities: stringArray(body.capabilities, "capabilities"),
    query: optionalText(body.discoveryQuery, "discoveryQuery"),
    mode: discoveryMode(body.discoveryMode),
    hasExplicitDependencies: Boolean(body.dependencies && typeof body.dependencies === "object" && !Array.isArray(body.dependencies) && Object.keys(body.dependencies).length > 0),
    legacyKind: body.kind !== undefined,
    docsText,
    docsUrls: collectDocumentationUrls(body),
  };
}

function collectDocumentationText(body: Record<string, unknown>): string | undefined {
  const fields = [
    body.docs,
    body.documentation,
    body.docsMarkdown,
    body.apiDocs,
    body.apiDocumentation,
    body.openApiSpec,
    body.openapi,
    body.openApi,
    body.curlExamples,
  ];
  const chunks = fields.flatMap((value) => documentationTextValue(value));
  const text = chunks.join("\n\n").trim();
  return text || undefined;
}

function documentationTextValue(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(documentationTextValue);
  if (value && typeof value === "object") return [JSON.stringify(value)];
  return [];
}

function collectDocumentationUrls(body: Record<string, unknown>): string[] {
  const raw = [
    body.docsUrl,
    body.documentationUrl,
    body.apiDocsUrl,
    body.openApiUrl,
    body.openapiUrl,
    body.specUrl,
    body.docsUrls,
  ];
  return raw
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .slice(0, 5);
}

function buildNpmSearchQuery(request: string, capabilities: string[] | undefined): string | undefined {
  const text = [...(capabilities ?? []), request].join(" ");
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9._@/-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 8);
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function emptyDiscovery(
  mode: ToolImplementationDiscoveryMode,
  note: string,
  evidence?: ToolBuilderDiscoveryEvidence,
): ToolImplementationDiscoveryResult {
  return {
    mode,
    candidates: [],
    dependencies: {},
    evidence: evidence ? [evidence] : [{ provider: "none", summary: note }],
    notes: [note],
  };
}

function discoveryModeFromEnv(): ToolImplementationDiscoveryMode {
  const raw = (process.env.TOOL_BUILDER_DISCOVERY ?? "disabled").toLowerCase();
  if (raw === "npm" || raw === "enabled" || raw === "true") return "npm";
  if (raw === "auto") return "auto";
  return "disabled";
}

function discoveryMode(value: unknown): ToolImplementationDiscoveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === "disabled" || value === "npm" || value === "auto") return value;
  throw new Error("discoveryMode must be disabled, npm, or auto");
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
  const out = value.map((item, index) => text(item, `${field}[${index}]`));
  return out.length > 0 ? out : undefined;
}

function isSafePackageName(value: string): boolean {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value);
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

const STOPWORDS = new Set([
  "create",
  "make",
  "tool",
  "that",
  "with",
  "from",
  "into",
  "using",
  "package",
  "library",
  "text",
  "input",
  "output",
  "return",
  "returns",
  "arbitrary",
]);

const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
