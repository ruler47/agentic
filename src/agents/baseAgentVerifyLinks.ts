import type { RunSourceRegistry } from "./sourceRegistry.js";
import type { TaskFrame } from "./taskFrame.js";

const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/g;

export type PresentedLinkProblem = { url: string; reason: string };

// Find links the final answer presents as where-to-buy / sources that the run did NOT open
// and confirm live this turn. A passed read with no out-of-stock signal is fine; a bot-blocked
// read is allowed via the honesty escape hatch (the agent tried); everything else — never
// opened, only discovered in search, only errored, or opened-but-out-of-stock — is a problem.
export function presentedLinkProblems(finalAnswer: string, registry: RunSourceRegistry): PresentedLinkProblem[] {
  const seen = new Set<string>();
  const problems: PresentedLinkProblem[] = [];
  for (const raw of finalAnswer.match(URL_RE) ?? []) {
    const url = stripTrailingPunctuation(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const verdict = registry.presentedLinkVerdict(url);
    if (verdict.passed && !verdict.outOfStock) continue;
    if (verdict.passed && verdict.outOfStock) {
      problems.push({ url, reason: "opened but the page signals OUT OF STOCK / not buyable" });
      continue;
    }
    if (verdict.blocked) continue; // opened but bot-blocked: allowed if disclosed (escape hatch)
    problems.push({
      url,
      reason: verdict.known ? "found in search but never opened/confirmed this run" : "never opened/confirmed this run",
    });
  }
  return problems;
}

// Corrective instruction when a grounding-hard answer presents unverified buy/source links.
export function presentedLinkVerifyInstruction(input: {
  taskFrame: TaskFrame;
  finalAnswer: string;
  registry: RunSourceRegistry;
}): string | undefined {
  if (input.taskFrame.researchContract.minResearchToolCalls < 1) return undefined;
  const problems = presentedLinkProblems(input.finalAnswer, input.registry);
  if (problems.length === 0) return undefined;
  const list = problems.slice(0, 8).map((problem) => `- ${problem.url} (${problem.reason})`).join("\n");
  return [
    "UNVERIFIED LINKS: your answer presents these as where to buy / as sources, but they were not opened and confirmed live this run:",
    list,
    "For each, open it with web.read and confirm it loads a live page for THIS exact item with a price and a buy/in-stock signal.",
    "Drop any link you cannot open, that is sold out, or that you could not load — or, if you keep it, label it explicitly as 'not verified'.",
    "Present only links you opened and confirmed this run; if none verify, say so honestly and give the closest alternative you DID confirm.",
  ].join("\n");
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}>"']+$/g, "");
}
