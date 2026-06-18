import type { BaseAgentRunContext } from "./baseAgentTypes.js";

export const THREAD_CONTEXT_ANSWER_FRAME_MARKER = "[runtime:thread-context-answer]";

export function taskWithThreadContextForFraming(task: string, runContext: BaseAgentRunContext): string {
  const thread = runContext.thread;
  if (!thread) return task;
  const threadText = [
    thread.summary,
    ...(thread.acceptedFacts ?? []),
    ...(thread.openQuestions ?? []),
  ].filter(Boolean).join("\n");
  if (!threadText.trim()) return task;
  if (looksLikeThreadContextAnswerTask(task)) {
    return [
      THREAD_CONTEXT_ANSWER_FRAME_MARKER,
      thread.summary ? `Thread summary: ${thread.summary}` : undefined,
      ...(thread.acceptedFacts ?? []).map((fact) => `Accepted fact: ${fact}`),
      ...(thread.openQuestions ?? []).map((question) => `Open question: ${question}`),
      `Current request: ${task}`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }
  if (!threadContextLooksLikeExternalAction(threadText)) return task;
  const context = [
    thread.summary ? `Thread summary: ${thread.summary}` : undefined,
    ...(thread.acceptedFacts ?? []).map((fact) => `Accepted fact: ${fact}`),
    ...(thread.openQuestions ?? []).map((question) => `Open question: ${question}`),
    `Current request: ${task}`,
  ].filter((line): line is string => Boolean(line));
  return context.length > 1 ? context.join("\n") : task;
}

export function looksLikeThreadContextAnswerTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /(?:previous|prior|earlier|above|that answer|that result|last\s+(?:answer|result|source)|used source|what source|which source|thread|conversation|context)/iu.test(normalized)
    || /(?:предыдущ|прошл|последн(?:ий|ем|его)?\s+ответ|выше|тот\s+ответ|этот\s+ответ|какой\s+источник|что\s+за\s+источник|откуда\s+(?:ты\s+)?(?:взял|получил|это|данн|информац)|в\s+переписк|контекст)/iu.test(normalized);
}

function threadContextLooksLikeExternalAction(text: string): boolean {
  return /(?:book|booking|reserve|reservation|appointment|schedule|submit|confirmation|запис|брон|брониров|резерв|отправ|подтвержд|форм)/iu.test(
    text,
  );
}
