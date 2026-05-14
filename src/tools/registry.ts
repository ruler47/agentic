import { EvidencePattern, Tool, ToolExecutionContext, ToolInput, ToolResult } from "./tool.js";

export type ToolUsageEvent = {
  toolName: string;
  outcome: "success" | "failure";
  at: Date;
};

export type ToolUsageReporter = (event: ToolUsageEvent) => Promise<void> | void;
export type ToolRuntimeContextProvider = (input: {
  tool: Tool;
  input: ToolInput;
  context: ToolExecutionContext;
}) => Promise<Partial<Omit<ToolExecutionContext, "toolName" | "now">> | undefined>
  | Partial<Omit<ToolExecutionContext, "toolName" | "now">>
  | undefined;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private usageReporter?: ToolUsageReporter;
  private runtimeContextProvider?: ToolRuntimeContextProvider;

  setUsageReporter(reporter: ToolUsageReporter | undefined): void {
    this.usageReporter = reporter;
  }

  setRuntimeContextProvider(provider: ToolRuntimeContextProvider | undefined): void {
    this.runtimeContextProvider = provider;
  }

  register(tool: Tool): void {
    // Phase 12 follow-up: defensively dedupe capabilities. Generated tools
    // sometimes ship `["browser-screenshot", "browser-screenshot",
    // "artifact-generation"]` from a template bug; the registry should
    // not propagate that noise into `findByCapability` results or the
    // /api/tools surface.
    const dedupedCaps = Array.from(new Set(tool.capabilities ?? []));
    const cleaned: Tool = dedupedCaps.length === tool.capabilities.length
      ? tool
      : { ...tool, capabilities: dedupedCaps };
    this.tools.set(cleaned.name, cleaned);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Phase 13 follow-up: capability lookup with prefix support. A request for
   * `web-search` returns:
   *   1. Tools whose capabilities array contains literal `web-search` (the
   *      built-in `web.search`).
   *   2. Tools whose capabilities contain a `<capability>-*` extension —
   *      e.g. user-built `web.duckduckgo` declares `web-search-duckduckgo`,
   *      so the agent now sees it as a valid `web-search` candidate
   *      without having to know the exact extension.
   * Exact matches come first to preserve historical behaviour; prefix
   * matches are appended in registration order. Caller code that picks
   * `[0]` keeps getting the literal-match tool when one exists.
   *
   * `policy` lets the runtime apply user-driven preferences (TB-005b):
   *   - `denied`: tool names the user asked NOT to use ("don't use X").
   *     They are filtered out of the result entirely.
   *   - `preferred`: tool names the user asked to use first ("use X").
   *     Promoted to the front of the list, in the order specified.
   */
  findByCapability(
    capability: string,
    policy?: { denied?: readonly string[]; preferred?: readonly string[] },
  ): Tool[] {
    // Phase 28 follow-up — capability-name normalization.
    //
    // LLMs (planners, council emitters, operators editing via PATCH)
    // emit capability tokens with inconsistent separators and case:
    //   "web-search" / "web_search" / "Web Search"
    //   "browser-screenshot" / "browser_screenshot"
    //   "market-timeseries" / "market_timeseries"
    // The runtime's `collectToolEvidence` always queries with the
    // hyphenated lowercase form, but tool authors / patchers often
    // store underscored or mixed-case capabilities. The mismatch
    // silently dropped a registered web.search tool out of every
    // worker's evidence pipeline ("Find bitcoin price" returned no
    // data because `findByCapability("web-search")` saw zero matches
    // when the only candidate had `web_search` in its capabilities).
    //
    // We normalize on BOTH sides — query and stored capability — to
    // lowercase + collapse `_`/whitespace to `-`. Exact-vs-prefix
    // semantics are preserved on the normalized strings.
    const normalize = (s: string): string =>
      s.trim().toLowerCase().replace(/[\s_]+/g, "-");
    const target = normalize(capability);
    const exact: Tool[] = [];
    const prefixed: Tool[] = [];
    for (const tool of this.list()) {
      const normalizedCaps = tool.capabilities.map(normalize);
      if (normalizedCaps.includes(target)) {
        exact.push(tool);
        continue;
      }
      if (normalizedCaps.some((entry) => entry.startsWith(`${target}-`))) {
        prefixed.push(tool);
      }
    }
    return applyToolPolicy([...exact, ...prefixed], policy);
  }

  /**
   * Phase 12 Slice B: collect evidence patterns from every registered tool
   * whose `evidencePatterns` array contains at least one entry whose `intent`
   * is in `intents`. Patterns from inactive intents are filtered out so
   * callers can pass the full list directly to `scoreUrlAgainstPatterns`.
   */
  evidencePatternsForIntents(intents: readonly string[]): EvidencePattern[] {
    if (intents.length === 0) return [];
    const out: EvidencePattern[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.evidencePatterns) continue;
      for (const pattern of tool.evidencePatterns) {
        if (intents.includes(pattern.intent)) out.push(pattern);
      }
    }
    return out;
  }

  async execute(
    tool: Tool,
    input: ToolInput,
    context?: Partial<Omit<ToolExecutionContext, "toolName">>,
  ): Promise<ToolResult> {
    const now = context?.now ?? new Date();
    const baseContext: ToolExecutionContext = {
      ...(context ?? {}),
      toolName: tool.name,
      now,
    };
    try {
      const providedContext = await this.runtimeContextProvider?.({
        tool,
        input,
        context: baseContext,
      });
      const result = await tool.run(input, {
        ...baseContext,
        ...(providedContext ?? {}),
        toolName: tool.name,
        now,
      });
      await this.recordUsage(tool.name, result.ok ? "success" : "failure");
      return result;
    } catch (error) {
      await this.recordUsage(tool.name, "failure");
      throw error;
    }
  }

  private async recordUsage(toolName: string, outcome: "success" | "failure"): Promise<void> {
    if (!this.usageReporter) return;

    try {
      await this.usageReporter({ toolName, outcome, at: new Date() });
    } catch (error) {
      console.warn(
        `Failed to record usage for tool ${toolName}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}

/**
 * Phase 13 follow-up (TB-005b): apply a user-driven tool policy to a
 * candidate list. Filters out denied tools, then re-orders surviving
 * tools so user-preferred ones come first (in the order the user
 * named them). Stable for the rest. Pure function for unit testing.
 */
function applyToolPolicy(
  tools: Tool[],
  policy?: { denied?: readonly string[]; preferred?: readonly string[] },
): Tool[] {
  if (!policy || ((policy.denied?.length ?? 0) === 0 && (policy.preferred?.length ?? 0) === 0)) {
    return tools;
  }
  const deniedSet = new Set(policy.denied ?? []);
  const survivors = tools.filter((tool) => !deniedSet.has(tool.name));
  const preferred = policy.preferred ?? [];
  if (preferred.length === 0) return survivors;
  const preferredOrder = new Map(preferred.map((name, index) => [name, index]));
  // Stable sort: preferred tools first in their declared order, then
  // the rest in original registration order.
  return survivors
    .map((tool, index) => ({
      tool,
      preferredIndex: preferredOrder.has(tool.name) ? preferredOrder.get(tool.name)! : -1,
      originalIndex: index,
    }))
    .sort((a, b) => {
      if (a.preferredIndex !== -1 && b.preferredIndex === -1) return -1;
      if (a.preferredIndex === -1 && b.preferredIndex !== -1) return 1;
      if (a.preferredIndex !== -1 && b.preferredIndex !== -1) {
        return a.preferredIndex - b.preferredIndex;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.tool);
}
