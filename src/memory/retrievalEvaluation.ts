import { SkillMemoryStore, MemoryScopeFilter } from "./skillMemory.js";

export type MemoryRetrievalEvaluationCase = {
  id: string;
  query: string;
  expectedMemoryIds: string[];
  visibleScopes?: MemoryScopeFilter[];
  limit?: number;
  minRecall?: number;
};

export type MemoryRetrievalEvaluationResult = {
  caseId: string;
  query: string;
  passed: boolean;
  recall: number;
  topHitMatched: boolean;
  expectedMemoryIds: string[];
  retrievedMemoryIds: string[];
  missingMemoryIds: string[];
  limit: number;
};

export type MemoryRetrievalEvaluationSummary = {
  passed: boolean;
  totalCases: number;
  passedCases: number;
  averageRecall: number;
  results: MemoryRetrievalEvaluationResult[];
};

export async function evaluateMemoryRetrieval(
  store: SkillMemoryStore,
  cases: MemoryRetrievalEvaluationCase[],
  options: { limit?: number } = {},
): Promise<MemoryRetrievalEvaluationSummary> {
  const results: MemoryRetrievalEvaluationResult[] = [];

  for (const evaluationCase of cases) {
    const limit = evaluationCase.limit ?? options.limit ?? 5;
    const expectedIds = unique(evaluationCase.expectedMemoryIds);
    const retrieved = await store.search(evaluationCase.query, limit, {
      visibleScopes: evaluationCase.visibleScopes,
      status: "accepted",
    });
    const retrievedIds = retrieved.map((memory) => memory.id);
    const retrievedSet = new Set(retrievedIds);
    const missingIds = expectedIds.filter((id) => !retrievedSet.has(id));
    const recall = expectedIds.length === 0 ? 1 : (expectedIds.length - missingIds.length) / expectedIds.length;
    const minRecall = evaluationCase.minRecall ?? 1;
    const topHitMatched = expectedIds.length === 0 ? retrievedIds.length === 0 : expectedIds.includes(retrievedIds[0] ?? "");

    results.push({
      caseId: evaluationCase.id,
      query: evaluationCase.query,
      passed: recall >= minRecall,
      recall: Number(recall.toFixed(3)),
      topHitMatched,
      expectedMemoryIds: expectedIds,
      retrievedMemoryIds: retrievedIds,
      missingMemoryIds: missingIds,
      limit,
    });
  }

  const passedCases = results.filter((result) => result.passed).length;
  const averageRecall =
    results.length === 0 ? 1 : results.reduce((sum, result) => sum + result.recall, 0) / results.length;

  return {
    passed: passedCases === results.length,
    totalCases: results.length,
    passedCases,
    averageRecall: Number(averageRecall.toFixed(3)),
    results,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
