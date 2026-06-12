import type { BaseAgentToolCatalogEntry, BaseAgentToolCreationRequest, BaseAgentToolEditRequest } from "../../../agents/baseAgent.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type { ToolMetadataStore, ToolModuleMetadata, ToolModuleVersionSummary } from "../../../tools/toolMetadataStore.js";
import { resolveToolRuntimeReadiness } from "../../../tools/toolRuntimeReadiness.js";

export function catalogEntryFromMetadata(
  tool: ToolModuleMetadata,
  versions: ToolModuleVersionSummary[],
  visibility: BaseAgentToolCatalogEntry["visibility"] = "global",
): BaseAgentToolCatalogEntry {
  return {
    name: tool.name,
    version: tool.version,
    source: tool.source,
    status: tool.status,
    description: tool.description,
    capabilities: tool.capabilities,
    startupMode: tool.startupMode,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    examples: tool.examples?.slice(0, 3).map((example) => ({
      title: example.title,
      input: example.input,
      output: example.output,
      expected: (example as { expected?: NonNullable<BaseAgentToolCatalogEntry["examples"]>[number]["expected"] }).expected,
    })),
    requiredConfigurationKeys: tool.requiredConfigurationKeys,
    requiredSecretHandles: tool.requiredSecretHandles,
    successCount: tool.successCount,
    failureCount: tool.failureCount,
    lastHealthOk: tool.lastHealthOk,
    lastHealthDetail: tool.lastHealthDetail,
    changeSummary: tool.changeSummary,
    visibility,
    versions: versions.slice(0, 8).map((version) => ({
      version: version.version,
      active: version.active,
      status: version.status,
      changeSummary: version.changeSummary,
      lastHealthDetail: version.lastHealthDetail,
      manualRunSuccessCount: version.manualRunEvidence?.successCount,
      manualRunFailureCount: version.manualRunEvidence?.failureCount,
    })),
  };
}

export async function agentCallableToolNames(input: {
  registeredToolNames: Iterable<string>;
  metadataTools: ToolModuleMetadata[];
  runtimeSettings?: ToolRuntimeSettingsStore;
  secretHandles?: SecretHandleStore;
  environment?: Record<string, string | undefined>;
}): Promise<string[]> {
  const registered = new Set(input.registeredToolNames);
  const readyRows = await Promise.all(
    input.metadataTools.map(async (tool) => ({
      tool,
      readiness: await resolveToolRuntimeReadiness(tool, {
        runtimeSettings: input.runtimeSettings,
        secretHandles: input.secretHandles,
        environment: input.environment,
      }),
    })),
  );
  return readyRows
    .filter(({ tool }) => registered.has(tool.name))
    .filter(({ tool }) => tool.status === "available")
    .filter(({ tool }) => !isGuardedExternalActionCommitTool(tool))
    .filter(({ readiness }) => readiness.ok)
    .map(({ tool }) => tool.name)
    .sort((a, b) => a.localeCompare(b));
}

function isGuardedExternalActionCommitTool(tool: ToolModuleMetadata): boolean {
  return tool.capabilities.some(
    (capability) =>
      capability === "external-action-commit" ||
      capability.startsWith("external-action-commit-"),
  );
}

export async function findExplicitRunScopedToolCandidate(input: {
  task: string;
  metadataTools: ToolModuleMetadata[];
  alreadyAllowedNames?: Iterable<string>;
  runtimeSettings?: ToolRuntimeSettingsStore;
  secretHandles?: SecretHandleStore;
  environment?: Record<string, string | undefined>;
}): Promise<{ metadata: ToolModuleMetadata; reason: string; score: number } | undefined> {
  if (!hasExplicitToolUseIntent(input.task)) return undefined;
  const alreadyAllowed = new Set(input.alreadyAllowedNames ?? []);
  const scored = await Promise.all(
    input.metadataTools
      .filter((tool) => tool.source === "generated")
      .filter((tool) => tool.status !== "available" && tool.status !== "failed")
      .filter((tool) => !alreadyAllowed.has(tool.name))
      .map(async (tool) => ({
        tool,
        score: explicitToolMatchScore(input.task, tool),
        readiness: await resolveToolRuntimeReadiness(tool, {
          runtimeSettings: input.runtimeSettings,
          secretHandles: input.secretHandles,
          environment: input.environment,
        }),
      })),
  );
  const candidates = scored
    .filter((item) => item.readiness.ok)
    .filter((item) => item.score >= 0.2)
    .sort(
      (a, b) =>
        b.score - a.score ||
        toolStatusRank(b.tool.status) - toolStatusRank(a.tool.status) ||
        a.tool.name.localeCompare(b.tool.name),
    );
  const best = candidates[0];
  if (!best) return undefined;
  return {
    metadata: best.tool,
    score: best.score,
    reason: `Explicit tool-use request matched ${best.tool.name}@${best.tool.version} (${best.tool.status}); attached as a run-scoped candidate.`,
  };
}

export async function findExplicitRunScopedToolVersionCandidate(input: {
  task: string;
  metadataTools: ToolModuleMetadata[];
  listVersions: (name: string) => Promise<ToolModuleVersionSummary[]>;
}): Promise<
  | {
      name: string;
      version: string;
      reason: string;
      versionSummary: ToolModuleVersionSummary;
    }
  | undefined
> {
  const task = input.task;
  const normalizedTask = normalizeForToolMatch(task);
  const hasToolIntent = hasExplicitToolUseIntent(task);
  const matches: Array<{
    name: string;
    version: string;
    exactRef: boolean;
    versionSummary: ToolModuleVersionSummary;
  }> = [];

  for (const tool of input.metadataTools) {
    if (tool.source !== "generated") continue;
    const normalizedName = normalizeForToolMatch(tool.name);
    const nameHit = normalizedTask.includes(normalizedName);
    if (!nameHit) continue;
    const versions = await input.listVersions(tool.name).catch(() => []);
    for (const version of versions) {
      if (!version.packageManifest) continue;
      if (version.status === "failed") continue;
      if (version.reviewStatus === "rejected") continue;
      const exactRef = hasExplicitToolVersionReference(task, tool.name, version.version);
      const versionHit = normalizedTask.includes(normalizeForToolMatch(version.version));
      if (!exactRef && !(hasToolIntent && versionHit)) continue;
      matches.push({
        name: tool.name,
        version: version.version,
        exactRef,
        versionSummary: version,
      });
    }
  }

  const best = matches.sort(
    (a, b) =>
      Number(b.exactRef) - Number(a.exactRef) ||
      toolStatusRank(b.versionSummary.status) - toolStatusRank(a.versionSummary.status) ||
      compareVersionStringsDesc(a.version, b.version) ||
      a.name.localeCompare(b.name),
  )[0];
  if (!best) return undefined;
  return {
    name: best.name,
    version: best.version,
    versionSummary: best.versionSummary,
    reason: `Explicit tool version reference matched ${best.name}@${best.version}; attached as a run-scoped candidate without changing the active global version.`,
  };
}

export function findReusableEditedCandidate(
  versions: ToolModuleVersionSummary[],
  request: BaseAgentToolEditRequest,
  activeVersion: string | undefined,
): ToolModuleVersionSummary | undefined {
  const candidates = versions
    .filter((version) => !version.active)
    .filter((version) => version.version !== activeVersion)
    .filter((version) => version.packageManifest)
    .filter((version) => version.status !== "failed")
    .filter((version) => version.reviewStatus !== "rejected")
    .map((version) => ({
      version,
      score: textSimilarityScore(
        request.request,
        version.changeSummary ?? version.description ?? "",
      ),
    }))
    .filter((item) => item.score >= 0.45)
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareVersionStringsDesc(a.version.version, b.version.version),
    );
  return candidates[0]?.version;
}

export function findReusableCreatedCandidate(
  versions: ToolModuleVersionSummary[],
  request: BaseAgentToolCreationRequest,
): ToolModuleVersionSummary | undefined {
  const requestedVersion = request.version;
  const hasNonDefaultVersion = versions.some(
    (version) => version.version !== "0.1.0",
  );
  const requestedVersionConstraint =
    requestedVersion && !(requestedVersion === "0.1.0" && hasNonDefaultVersion)
      ? requestedVersion
      : undefined;
  const candidates = versions
    .filter(
      (version) =>
        !requestedVersionConstraint ||
        version.version === requestedVersionConstraint,
    )
    .filter((version) => version.packageManifest)
    .filter((version) => version.status !== "failed")
    .filter((version) => version.reviewStatus !== "rejected")
    .map((version) => ({
      version,
      score: textSimilarityScore(
        [request.request, request.description, ...(request.capabilities ?? [])]
          .filter(Boolean)
          .join(" "),
        [
          version.changeSummary,
          version.description,
          ...(version.capabilities ?? []),
        ]
          .filter(Boolean)
          .join(" "),
      ),
    }))
    .sort(
      (a, b) =>
        toolVersionReuseRank(b.version) - toolVersionReuseRank(a.version) ||
        compareVersionStringsDesc(a.version.version, b.version.version) ||
        b.score - a.score,
    );
  return candidates[0]?.version;
}

function toolVersionReuseRank(version: ToolModuleVersionSummary): number {
  if (version.status === "available") return 4;
  if (version.status === "loaded") return 3;
  if (version.status === "disabled" && version.manualRunEvidence?.latestSuccess)
    return 2;
  if (version.status === "disabled") return 1;
  return 0;
}

function textSimilarityScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function explicitToolMatchScore(task: string, tool: ToolModuleMetadata): number {
  const normalizedTask = normalizeForToolMatch(task);
  const normalizedName = normalizeForToolMatch(tool.name);
  if (normalizedTask.includes(normalizedName)) return 1;
  // Match ONLY on distinctive tool-name tokens ("амл" -> aml in
  // crypto.aml.gl). Description/capability text similarity is forbidden
  // here: it fuzzy-matched a stale example.com reservation-commit tool to
  // an ordinary "подготовь запись" booking task and the unused-candidate
  // gate then failed the whole run. Tool selection from prose must stay
  // deterministic (project rule: no fuzzy tool inference).
  const nameTokens = [...tokenSet(normalizedName)].filter(isDistinctiveToolNameToken);
  if (nameTokens.length === 0) return 0;
  const taskTokens = tokenSet(normalizedTask);
  const exactNameHits = nameTokens.filter((token) => taskTokens.has(token)).length;
  return exactNameHits > 0 ? exactNameHits / nameTokens.length : 0;
}

const GENERIC_TOOL_NAME_TOKENS = new Set([
  "http", "https", "www", "com", "org", "net", "api", "tool", "service",
  "external", "action", "commit", "prepare", "client", "generic", "web",
  "data", "file", "json", "text", "test",
]);

function isDistinctiveToolNameToken(token: string): boolean {
  if (token.length < 3) return false;
  if (/^\d+$/.test(token)) return false;
  return !GENERIC_TOOL_NAME_TOKENS.has(token);
}

function hasExplicitToolUseIntent(task: string): boolean {
  return /\b(use|using|tool|through|via|with)\b|(?:использ|через|тулз|тул|инструмент)/iu.test(task);
}

function hasExplicitToolVersionReference(
  task: string,
  name: string,
  version: string,
): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directRef = new RegExp(
    `(^|[^\\p{L}\\p{N}_.-])${escapedName}\\s*(?:@|#|\\b(?:v|version|верси[яию]|версии)\\s*)v?${escapedVersion}(?=$|[^\\p{L}\\p{N}_.-])`,
    "iu",
  );
  return directRef.test(task);
}

function normalizeForToolMatch(value: string): string {
  return transliterateCyrillic(value.toLowerCase()).replace(/[^a-z0-9_.-]+/g, " ").trim();
}

function transliterateCyrillic(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
  };
  return value.replace(/[а-яё]/giu, (char) => map[char.toLowerCase()] ?? char);
}

function toolStatusRank(status: ToolModuleMetadata["status"]): number {
  if (status === "loaded") return 2;
  if (status === "disabled") return 1;
  return 0;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[_.-]+/g, " ")
      .replace(/[^a-zа-я0-9]+/giu, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !/^0x[a-f0-9]{16,}$/i.test(token))
      .filter(
        (token) =>
          !["tool", "editing", "edit", "version", "generated"].includes(token),
      ),
  );
}

function compareVersionStringsDesc(left: string, right: string): number {
  const a = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const b = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] || 0) - (a[index] || 0);
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}



export async function availableToolCatalog(input: {
  allowedNames: string[];
  toolMetadata?: ToolMetadataStore;
}): Promise<BaseAgentToolCatalogEntry[]> {
  if (!input.toolMetadata || input.allowedNames.length === 0) return [];
  const allowed = new Set(input.allowedNames);
  const rows = await input.toolMetadata.list();
  return rows
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => catalogEntryFromMetadata(tool, tool.versions ?? [], "global"))
    .sort((a, b) => a.name.localeCompare(b.name));
}
