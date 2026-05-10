export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find JSON object in model output:\n${text}`);
  }

  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch (firstError) {
    // Phase 12 follow-up: planner/council outputs sometimes embed code
    // samples with backslashes that break strict JSON parsing
    // ("Bad escaped character at position N"). Make a best-effort
    // recovery: replace lone backslashes that are NOT a valid JSON
    // escape with their double-backslashed form, then retry. If that
    // still fails, surface the original error so callers can fall
    // back to whatever recovery logic they have.
    const escaped = slice.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(escaped) as T;
    } catch {
      throw firstError;
    }
  }
}
