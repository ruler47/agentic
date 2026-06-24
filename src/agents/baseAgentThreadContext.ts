import type { BaseAgentRunContext } from "./baseAgentTypes.js";

export const THREAD_CONTEXT_ANSWER_FRAME_MARKER = "[runtime:thread-context-answer]";
export const EXTERNAL_ACTION_CONTINUATION_FRAME_MARKER = "[runtime:external-action-continuation]";

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
  if (looksLikeExternalActionContinuationDetails(task)) {
    return buildExternalActionContinuationFramingTask(task, runContext);
  }
  const context = [
    thread.summary ? `Thread summary: ${thread.summary}` : undefined,
    ...(thread.acceptedFacts ?? []).map((fact) => `Accepted fact: ${fact}`),
    ...(thread.openQuestions ?? []).map((question) => `Open question: ${question}`),
    `Current request: ${task}`,
  ].filter((line): line is string => Boolean(line));
  return context.length > 1 ? context.join("\n") : task;
}

export function buildExternalActionContinuationFramingTask(
  task: string,
  runContext: BaseAgentRunContext,
): string {
  const thread = runContext.thread;
  if (!thread) return task;
  const threadText = [
    thread.summary,
    ...(thread.acceptedFacts ?? []),
    ...(thread.openQuestions ?? []),
  ].filter(Boolean).join("\n");
  const actionHint = inferExternalActionContinuationHint(threadText);
  return [
    EXTERNAL_ACTION_CONTINUATION_FRAME_MARKER,
    `Previous external action intent: ${actionHint}.`,
    "The current request supplies user details, contact details, timing, or preferences for that already requested external action.",
    "Continue preparing the external action for approval. Avoid self-service instructions unless execution is impossible.",
    "Operator boundary: prepare/select/fill only until explicit approval or the structured execution setting allows execution.",
    thread.summary ? `Thread summary: ${thread.summary}` : undefined,
    ...(thread.acceptedFacts ?? []).map((fact) => `Accepted fact: ${fact}`),
    ...(thread.openQuestions ?? []).map((question) => `Open question: ${question}`),
    `Current request details: ${task}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
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

export function looksLikeExternalActionContinuationDetails(task: string): boolean {
  const hasContactOrIdentity = /(?:\+?\d[\d\s().-]{6,}\d|[\w.+-]+@[\w.-]+\.[a-z]{2,}|имя|телефон|почт[аы]|email|e-mail|contact|phone|данные|Димитрий|Dimitrii)/iu.test(
    task,
  );
  const hasTimingOrPreference = /(?:после\s*\d{1,2}(?::|\.)?\d{0,2}|субб?от|воскрес|выходн|любой\s+из\s+(?:двух|этих)\s+дн|время\s+любое|tomorrow|weekend|saturday|sunday|after\s+\d{1,2}|any\s+time)/iu.test(
    task,
  );
  const hasServiceOrActionDetails = /(?:стриж|барбер|салон|услуг|service|haircut|barber|booking|appointment|запис|брон|reserve|book)/iu.test(
    task,
  );
  return hasContactOrIdentity && (hasTimingOrPreference || hasServiceOrActionDetails);
}

function inferExternalActionContinuationHint(threadText: string): string {
  if (/(?:стриж|барбер|салон|haircut|barber|salon)/iu.test(threadText)) {
    return "schedule a haircut/barbershop appointment from the previously discussed Marbella options";
  }
  if (/(?:ресторан|столик|restaurant|table)/iu.test(threadText)) {
    return "reserve a restaurant table from the previously discussed options";
  }
  return "prepare the previously requested external booking/reservation/submission";
}
