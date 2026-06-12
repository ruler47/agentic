export type ModelCapability =
  | "chat"
  | "embedding"
  | "vision"
  | "reasoning"
  | "coding"
  | "tool-calling";

export type CatalogModelRecord = {
  id: string;
  ownedBy?: string;
  capabilities: ModelCapability[];
  capabilitySource: "inferred" | "operator";
};

export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const normalized = modelId.toLowerCase();
  const capabilities = new Set<ModelCapability>();

  if (isEmbeddingModelId(normalized)) {
    capabilities.add("embedding");
    return [...capabilities];
  }

  capabilities.add("chat");

  if (isReasoningModelId(normalized)) capabilities.add("reasoning");
  if (isCodingModelId(normalized)) capabilities.add("coding");
  if (isVisionModelId(normalized)) capabilities.add("vision");
  if (isLikelyToolCallingModelId(normalized)) capabilities.add("tool-calling");

  return [...capabilities];
}

export function isEmbeddingModelId(modelId: string): boolean {
  return /\b(embed|embedding|nomic-embed|bge-|e5-|gte-|text-embedding)\b/i.test(modelId);
}

export function isVisionModelId(modelId: string): boolean {
  return /\b(vision|vl|v[il]m|llava|pixtral|molmo|minicpm-v|qwen[.-]?vl|qwen2[.-]?vl|qwen2\.5[.-]?vl|gpt-4o|omni|gemini)\b/i.test(modelId);
}

function isReasoningModelId(modelId: string): boolean {
  return /\b(qwen3|qwen3\.|qwen3-|qwen\/qwen3|gpt-oss|o[134]|reason|r1|nemotron)\b/i.test(modelId);
}

function isCodingModelId(modelId: string): boolean {
  return /\b(coder|coding|code|codestral|deepseek-coder|starcoder)\b/i.test(modelId);
}

function isLikelyToolCallingModelId(modelId: string): boolean {
  return /\b(qwen|gpt|claude|gemini|llama-3\.1|llama-3\.2|llama-3\.3|mistral|nemotron)\b/i.test(modelId);
}

export type ModelCapabilityOverrides = Record<string, ModelCapability[]>;

export function decorateCatalogModel(
  input: { id: string; ownedBy?: string },
  overrides: ModelCapabilityOverrides = {},
): CatalogModelRecord {
  const override = overrides[input.id] ?? overrides[input.id.toLowerCase()];
  const inferred = inferModelCapabilities(input.id);
  const capabilities = override ? mergeCapabilities(inferred, override) : inferred;
  return {
    ...input,
    capabilities,
    capabilitySource: override ? "operator" : "inferred",
  };
}

export function filterCatalogModelsByCapability(
  models: CatalogModelRecord[],
  capability: ModelCapability,
): CatalogModelRecord[] {
  return models.filter((model) => model.capabilities.includes(capability));
}

export function parseModelCapabilityOverrides(value: string | undefined): ModelCapabilityOverrides {
  const overrides: ModelCapabilityOverrides = {};
  if (!value?.trim()) return overrides;

  for (const entry of value.split(";")) {
    const [rawModelId, rawCapabilities] = entry.split("=");
    const modelId = rawModelId?.trim();
    if (!modelId || !rawCapabilities) continue;
    const capabilities = rawCapabilities
      .split(",")
      .map((capability) => normalizeCapability(capability))
      .filter((capability): capability is ModelCapability => Boolean(capability));
    if (capabilities.length === 0) continue;
    overrides[modelId] = capabilities;
    overrides[modelId.toLowerCase()] = capabilities;
  }

  return overrides;
}

function mergeCapabilities(inferred: ModelCapability[], override: ModelCapability[]): ModelCapability[] {
  const merged = new Set<ModelCapability>();
  for (const capability of inferred) merged.add(capability);
  for (const capability of override) merged.add(capability);
  if (merged.has("embedding")) {
    return ["embedding"];
  }
  return [...merged];
}

function normalizeCapability(value: string): ModelCapability | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "chat" ||
    normalized === "embedding" ||
    normalized === "vision" ||
    normalized === "reasoning" ||
    normalized === "coding" ||
    normalized === "tool-calling"
  ) {
    return normalized;
  }
  if (normalized === "tools" || normalized === "function-calling") return "tool-calling";
  if (normalized === "code") return "coding";
  return undefined;
}
