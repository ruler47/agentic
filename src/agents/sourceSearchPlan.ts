export type SourceResearchPolicy = {
  externalResearch: "allowed" | "forbidden";
  reason: string;
  searchPlan?: SearchQueryPlan;
};

export type SearchQueryPlan = {
  strategy: "none" | "single_source" | "mixed_language" | "local_provider" | "official_docs";
  requiresMixedLanguageSearch: boolean;
  queries: SearchQueryPlanItem[];
};

export type SearchQueryPlanItem = {
  query: string;
  language: string;
  purpose: string;
  expectedSourceTypes: string[];
};

export function detectNoExternalResearchInstruction(task: string): boolean {
  if (/(?:не\s+используй|do\s+not\s+use|don't\s+use).{0,48}(?:страниц[а-яё]*\s+поиска|search\s+results?\s+pages?).{0,48}(?:как\s+источн|as\s+sources?)/i.test(task)) {
    return false;
  }
  return /(?:без\s+(?:интернета|веба|web|поиска)|не\s+(?:ищи|гугли|гуглить|используй).{0,24}(?:интернет|web|поиск|google)|without\s+(?:internet|web|search)|no\s+(?:internet|web|search)|do\s+not\s+(?:search|browse|use\s+the\s+web)|don't\s+(?:search|browse|use\s+the\s+web))/i
    .test(task);
}

export function buildSourceResearchPolicy(input: {
  task: string;
  mode: string;
  researchDepth: string;
  externalAction: boolean;
}): SourceResearchPolicy {
  if (detectNoExternalResearchInstruction(input.task)) {
    return {
      externalResearch: "forbidden",
      reason: "The user explicitly asked not to use internet/web/search.",
    };
  }
  if (input.mode === "local_utility") {
    return {
      externalResearch: "forbidden",
      reason: "Local file/document/data tasks should use local tools unless the user asks for external discovery.",
    };
  }
  if (input.mode === "thread_context_answer") {
    return {
      externalResearch: "forbidden",
      reason: "Follow-up can answer from conversation context unless the user asks to refresh.",
    };
  }
  const searchPlan = buildSearchQueryPlan(input);
  return {
    externalResearch: "allowed",
    reason: searchPlan
      ? "External research is allowed when needed; follow the search plan before relying on sources."
      : "External research is allowed only if the direct answer needs current or external evidence.",
    searchPlan,
  };
}

export function buildSearchQueryPlan(input: {
  task: string;
  mode: string;
  researchDepth: string;
  externalAction: boolean;
}): SearchQueryPlan | undefined {
  if (input.mode === "direct_fact" || input.mode === "thread_context_answer" || input.mode === "local_utility") {
    return undefined;
  }
  const userLanguage = detectUserLanguage(input.task);
  if (isDocsOrApiTask(input.task)) {
    return {
      strategy: "official_docs",
      requiresMixedLanguageSearch: false,
      queries: [
        {
          query: compactQuery(`${input.task} official docs API reference`),
          language: userLanguage,
          purpose: "Find official documentation, reference pages, schemas, or examples.",
          expectedSourceTypes: ["official_docs", "primary"],
        },
      ],
    };
  }
  if (input.externalAction || isLocalProviderTask(input.task)) {
    return {
      strategy: "local_provider",
      requiresMixedLanguageSearch: false,
      queries: [
        {
          query: compactQuery(input.task),
          language: userLanguage,
          purpose: "Find local actionable provider/source pages in the user's requested location.",
          expectedSourceTypes: ["primary", "pricing", "directory"],
        },
      ],
    };
  }
  if (input.mode === "product_selection" || input.researchDepth === "structured_selection" || input.researchDepth === "multi_source") {
    const englishQuery = englishQueryForTask(input.task);
    return {
      strategy: "mixed_language",
      requiresMixedLanguageSearch: userLanguage !== "en",
      queries: uniqueQueries([
        {
          query: compactQuery(input.task),
          language: userLanguage,
          purpose: "Search in the user's language to preserve local wording and constraints.",
          expectedSourceTypes: ["primary", "pricing", "product", "review", "official_docs"],
        },
        {
          query: englishQuery,
          language: "en",
          purpose: "Search in English to widen global coverage and reduce locale-only blind spots.",
          expectedSourceTypes: ["primary", "pricing", "product", "review", "official_docs"],
        },
      ]),
    };
  }
  if (input.mode === "current_lookup") {
    return {
      strategy: "single_source",
      requiresMixedLanguageSearch: false,
      queries: [
        {
          query: compactQuery(input.task),
          language: userLanguage,
          purpose: "Find one current source with the requested value or fact.",
          expectedSourceTypes: ["primary", "pricing", "unknown"],
        },
      ],
    };
  }
  return undefined;
}

export function detectSearchQueryLanguage(query: string): string {
  if (/[а-яё]/i.test(query)) return "ru";
  if (/[áéíóúñü¿¡]/i.test(query)) return "es";
  if (/[a-z]/i.test(query)) return "en";
  return "unknown";
}

export function sourceSearchPlanRepairInstructionForModel(input: {
  policy: SourceResearchPolicy;
  executedLanguages: string[];
  toolNames: string[];
}): string | undefined {
  const plan = input.policy.searchPlan;
  if (!plan?.requiresMixedLanguageSearch) return undefined;
  if (input.policy.externalResearch !== "allowed") return undefined;
  const hasSearchTool = input.toolNames.some((toolName) => /(?:^|[._-])search$/i.test(toolName) || /^web[._-]search$/i.test(toolName));
  if (!hasSearchTool) return undefined;
  const executed = new Set(input.executedLanguages);
  const missingQueries = plan.queries.filter((query) => query.language !== "unknown" && !executed.has(query.language));
  if (!missingQueries.length) return undefined;
  return [
    "The source search plan is not satisfied yet.",
    "Before finalizing this broad/current research task, run the missing planned search angle(s):",
    ...missingQueries.map((query) => `- [${query.language}] ${query.query} — ${query.purpose}`),
    "After that, continue with the strongest sources and avoid repeating already-read URLs.",
  ].join("\n");
}

function detectUserLanguage(task: string): string {
  if (/[а-яё]/i.test(task)) return "ru";
  if (/[áéíóúñü¿¡]/i.test(task)) return "es";
  return "en";
}

function isDocsOrApiTask(task: string): boolean {
  return /\b(?:api|openapi|swagger|docs?|documentation|reference|endpoint|curl)\b|(?:документац|эндпоинт|апи|схем[ауы])/i.test(task);
}

function isLocalProviderTask(task: string): boolean {
  return /\b(?:near|nearby|restaurant|reservation|barber|barbershop|salon|clinic|doctor|venue|hotel)\b|(?:рядом|поблизости|ресторан|столик|барбер|барбершоп|салон|клиник|врач|площадк|отель|марбель|мадрид)/i.test(task);
}

function englishQueryForTask(task: string): string {
  const translated = task
    .toLowerCase()
    .replace(/лучши[йеаях]*/g, "best")
    .replace(/найди|подбери|выбери|посоветуй|порекомендуй/g, "find recommend")
    .replace(/сравни|сравнить|сравнение/g, "compare")
    .replace(/актуальн\w*/g, "current")
    .replace(/цена|стоимость|цен[уы]/g, "price")
    .replace(/бюджет|до\s+(\d+)/g, "budget $1")
    .replace(/ноутбук\w*/g, "laptop")
    .replace(/программирован\w*/g, "programming")
    .replace(/локальн\w*\s+llm|llm/g, "local LLM")
    .replace(/игр[ыа]?/g, "gaming")
    .replace(/ресторан\w*/g, "restaurant")
    .replace(/барбершоп|барбер/g, "barbershop")
    .replace(/[^\p{L}\p{N}$€£+\-. ]+/gu, " ");
  const latinTokens = translated
    .split(/\s+/)
    .filter((token) => /^[a-z0-9$€£+\-.]+$/i.test(token) && token.length > 1)
    .slice(0, 14);
  const query = latinTokens.length >= 3
    ? latinTokens.join(" ")
    : `best current options comparison ${new Date().getUTCFullYear()}`;
  return compactQuery(query);
}

function compactQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function uniqueQueries(queries: SearchQueryPlanItem[]): SearchQueryPlanItem[] {
  const seen = new Set<string>();
  const result: SearchQueryPlanItem[] = [];
  for (const query of queries) {
    const key = query.query.toLowerCase();
    if (!query.query || seen.has(key)) continue;
    seen.add(key);
    result.push(query);
  }
  return result;
}
