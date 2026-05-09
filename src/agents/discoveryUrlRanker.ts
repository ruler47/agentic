import { LlmClient } from "../llm/client.js";
import { Subtask } from "../types.js";
import { extractJson } from "../utils/json.js";

function safeExtractJson(text: string): unknown | null {
  try {
    return extractJson<unknown>(text);
  } catch {
    return null;
  }
}

/**
 * Phase 12 Slice D: pick the best browser-discovery URLs by asking a small
 * LLM call to read the subtask + candidate URLs and return a ranking. This
 * removes the last hardcoded fallback step (`scoreArtifactUrl` over a fixed
 * pattern set) for the long tail of intents that no built-in or memory
 * pattern covers — the model uses its world knowledge to decide which URL is
 * actually relevant.
 *
 * Two failure modes always fall back to the heuristic ranker provided by the
 * caller:
 * 1. `URL_RANKER_LLM=disabled` env (operator override).
 * 2. The LLM returns no parseable JSON, or fewer URLs than asked, or URLs
 *    that are not in the candidate set.
 *
 * The function returns metadata (`source: "llm" | "heuristic"`) and a
 * `rejected` array so traces can show why a URL was passed over.
 */

export type DiscoveryUrlRankerInput = {
  subtask: Pick<Subtask, "title" | "prompt">;
  candidateUrls: string[];
  candidateContext: string;
  intents: string[];
  limit: number;
  /**
   * Per-URL preview snippet (first 280 chars or so) extracted from search
   * results / prior evidence. Helps the LLM judge relevance without
   * fetching pages.
   */
  candidatePreviews?: Record<string, string>;
};

export type DiscoveryUrlRankerOutput = {
  selected: string[];
  rejected: Array<{ url: string; reason: string }>;
  source: "llm" | "heuristic";
  reason?: string;
};

export type DiscoveryUrlRankerOptions = {
  llm?: LlmClient;
  fallback: (limit: number) => string[];
  /** Override env detection in tests. */
  envValue?: string;
};

const RANKER_SYSTEM_PROMPT = `You rank browser-navigation URLs by their usefulness for a specific subtask.
Output strict JSON with the shape {"selected": ["url1", ...], "rejected": [{"url": "...", "reason": "..."}]}.
Rules:
- "selected" length must equal the requested limit unless fewer candidates exist.
- "selected" URLs must be drawn verbatim from the candidate list.
- Pick URLs that directly answer the subtask. Reject off-topic, login-walled, or generic-landing URLs.
- "rejected" entries must explain in one short sentence why each was passed over.
- Do not invent URLs. Do not include any prose outside the JSON object.`;

export async function rankDiscoveryUrls(
  input: DiscoveryUrlRankerInput,
  options: DiscoveryUrlRankerOptions,
): Promise<DiscoveryUrlRankerOutput> {
  const { subtask, candidateUrls, intents, limit, candidatePreviews } = input;
  const env = options.envValue ?? process.env.URL_RANKER_LLM ?? "";
  const heuristic = (): DiscoveryUrlRankerOutput => ({
    selected: options.fallback(limit),
    rejected: [],
    source: "heuristic",
  });

  if (candidateUrls.length === 0) return heuristic();
  if (env === "disabled") {
    return { ...heuristic(), reason: "URL_RANKER_LLM=disabled" };
  }
  if (!options.llm) {
    return { ...heuristic(), reason: "no LLM client available" };
  }
  if (candidateUrls.length === 1) {
    // Trivial case: one candidate, no need to call the LLM.
    return { selected: [candidateUrls[0]], rejected: [], source: "heuristic" };
  }

  const previews = candidatePreviews ?? {};
  const prompt = [
    `Subtask: ${truncate(subtask.title, 200)}`,
    `Subtask prompt:\n${truncate(subtask.prompt, 1200)}`,
    `Inferred task intents (informational): ${intents.join(", ") || "(none)"}`,
    `Limit: ${limit}`,
    "Candidate URLs:",
    ...candidateUrls.map((url, idx) => {
      const preview = previews[url] ? ` — ${truncate(previews[url], 220)}` : "";
      return `${idx + 1}. ${url}${preview}`;
    }),
    "",
    "Return JSON only.",
  ].join("\n");

  let raw: string;
  try {
    raw = await options.llm.complete([
      { role: "system", content: RANKER_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (error) {
    return {
      ...heuristic(),
      reason: `LLM call failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  const parsed = safeExtractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { ...heuristic(), reason: "LLM did not return parseable JSON" };
  }

  const selectedRaw = (parsed as { selected?: unknown }).selected;
  const rejectedRaw = (parsed as { rejected?: unknown }).rejected;

  const candidateSet = new Set(candidateUrls);
  const selected: string[] = [];
  if (Array.isArray(selectedRaw)) {
    for (const url of selectedRaw) {
      if (typeof url !== "string") continue;
      if (!candidateSet.has(url)) continue;
      if (selected.includes(url)) continue;
      selected.push(url);
      if (selected.length >= limit) break;
    }
  }
  if (selected.length === 0) {
    return { ...heuristic(), reason: "LLM selected no valid candidate URLs" };
  }

  const rejected: Array<{ url: string; reason: string }> = [];
  if (Array.isArray(rejectedRaw)) {
    for (const item of rejectedRaw) {
      if (!item || typeof item !== "object") continue;
      const url = (item as { url?: unknown }).url;
      const reason = (item as { reason?: unknown }).reason;
      if (typeof url !== "string" || typeof reason !== "string") continue;
      if (!candidateSet.has(url)) continue;
      rejected.push({ url, reason: truncate(reason, 240) });
    }
  }

  return { selected, rejected, source: "llm" };
}

function truncate(value: string | undefined, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
