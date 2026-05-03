import { ConversationThreadRecord } from "./types.js";

export type ThreadResolutionDecision =
  | "explicit_thread"
  | "continue_thread"
  | "clarification"
  | "correction"
  | "new_task";

export type ThreadResolutionInput = {
  task: string;
  requesterUserId: string;
  channel: string;
  requestedThreadId?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  threads: ConversationThreadRecord[];
};

export type ThreadResolutionResult = {
  decision: ThreadResolutionDecision;
  thread?: ConversationThreadRecord;
  reason: string;
};

const newThreadMarkers = [
  /^\/new\b/i,
  /^new task\b/i,
  /^нов(ая|ую)\s+задач/i,
  /^начни\s+нов/i,
  /^создай\s+нов(ый|ую)\s+тред/i,
  /\bотдельн(ая|ую)\s+задач/i,
];

const correctionMarkers = [
  /^нет\b/i,
  /^не\s+то\b/i,
  /^wrong\b/i,
  /^actually\b/i,
  /(^|\s)исправ(ь|ить|им)(\s|$)/i,
  /(^|\s)передел(ай|ать)(\s|$)/i,
  /(^|\s)поправ(ь|ить)(\s|$)/i,
  /(^|\s)скорректир/i,
  /(^|\s)неправильно(\s|$)/i,
];

const clarificationMarkers = [
  /^(что|почему|как|если)(\s|$)/i,
  /^а\s+(что|почему|как|если)(\s|$)/i,
  /^и\s+(что|почему|как|если)(\s|$)/i,
  /(^|\s)уточн(и|ить|ение)(\s|$)/i,
  /(^|\s)объясни(\s|$)/i,
  /(^|\s)поясни(\s|$)/i,
  /\bwhy\b/i,
  /\bhow\b/i,
];

const continuationMarkers = [
  /^продолж(ай|и)(\s|$)/i,
  /^дальше(\s|$)/i,
  /^теперь(\s|$)/i,
  /^тогда(\s|$)/i,
  /^ок(ей)?[, ]/i,
  /^ещ[её](\s|$)/i,
  /^и\s+(добавь|сделай|найди|проверь|посмотри|покажи)(\s|$)/i,
  /^а\s+(теперь|ещ[её]|также|добавь|сделай|найди|проверь|посмотри|покажи)(\s|$)/i,
  /(^|\s)в\s+эт(ом|ой|от)(\s|$)/i,
  /(^|\s)там(\s|$)/i,
  /(^|\s)тут(\s|$)/i,
  /(^|\s)это(\s|$)/i,
  /\bthis\b/i,
  /\bthat\b/i,
  /\bit\b/i,
];

export function resolveConversationThread(input: ThreadResolutionInput): ThreadResolutionResult {
  const task = normalize(input.task);
  const candidates = matchingCandidates(input);
  const latest = candidates[0];

  if (input.requestedThreadId) {
    const explicit = input.threads.find((thread) => thread.id === input.requestedThreadId);
    return explicit
      ? {
          decision: "explicit_thread",
          thread: explicit,
          reason: "The request explicitly selected an existing conversation thread.",
        }
      : {
          decision: "new_task",
          reason: "The explicitly selected conversation thread was not found.",
        };
  }

  if (!latest) {
    return { decision: "new_task", reason: "No matching active thread exists for this requester and channel." };
  }

  if (matchesAny(task, newThreadMarkers)) {
    return { decision: "new_task", reason: "The message explicitly asks to start a new task/thread." };
  }

  if (matchesAny(task, correctionMarkers)) {
    return {
      decision: "correction",
      thread: latest,
      reason: "The message looks like a correction to the latest matching thread.",
    };
  }

  if (matchesAny(task, clarificationMarkers)) {
    return {
      decision: "clarification",
      thread: latest,
      reason: "The message looks like a clarification or follow-up question.",
    };
  }

  if (matchesAny(task, continuationMarkers)) {
    return {
      decision: "continue_thread",
      thread: latest,
      reason: "The message contains continuation markers and has a matching source thread/chat.",
    };
  }

  if (input.sourceThreadId) {
    return {
      decision: "continue_thread",
      thread: latest,
      reason: "The inbound channel provided the same source thread id as an existing conversation.",
    };
  }

  return {
    decision: "new_task",
    reason: "The message does not look like a continuation, clarification, or correction.",
  };
}

function matchingCandidates(input: ThreadResolutionInput): ConversationThreadRecord[] {
  return input.threads
    .filter((thread) => thread.status === "active")
    .filter((thread) => thread.requesterUserId === input.requesterUserId)
    .filter((thread) => thread.channel === input.channel)
    .filter((thread) => {
      if (input.sourceThreadId) return thread.sourceThreadId === input.sourceThreadId;
      if (input.sourceChatId) return thread.sourceChatId === input.sourceChatId;
      return false;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
