export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_MAX_TOKENS = positiveIntegerFromEnv("LLM_MAX_TOKENS") ?? 6_000;
export const TOOL_RESULT_PREVIEW_CHARS = 6_000;

function positiveIntegerFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The main agent loop is real reasoning work — it defaults to tier M.
 * Tier S is reserved for cheap utility calls (ranking, classification);
 * pointing the loop at S silently ran the whole product on the smallest
 * configured model whenever callers omitted modelTier.
 */
export const DEFAULT_AGENT_LOOP_TIER = "M" as const;
