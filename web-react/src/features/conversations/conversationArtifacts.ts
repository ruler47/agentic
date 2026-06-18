import type { AgentArtifact, AgentRunRecord, ConversationThreadMessage } from "@/api/types";

export function artifactsForMessage(
  message: ConversationThreadMessage,
  runs: AgentRunRecord[],
): AgentArtifact[] {
  if (!message.runId) return [];
  const run = runs.find((candidate) => candidate.id === message.runId);
  return run?.result?.artifacts ?? [];
}

export function hydrateMarkdownArtifactLinks(markdown: string, artifacts: AgentArtifact[]): string {
  if (artifacts.length === 0) return markdown;
  return markdown.replace(/(!?\[[^\]]*\]\()([^)]+)(\))/g, (_match, prefix: string, href: string, suffix: string) => {
    const resolved = resolveArtifactHref(href, artifacts);
    return `${prefix}${resolved ?? href}${suffix}`;
  });
}

export function unreferencedArtifacts(markdown: string, artifacts: AgentArtifact[]): AgentArtifact[] {
  const referenced = new Set<string>();
  for (const artifact of artifacts) {
    if (markdown.includes(artifact.url) || markdown.includes(artifact.filename)) {
      referenced.add(artifact.id);
    }
  }
  return artifacts.filter((artifact) => !referenced.has(artifact.id));
}

function resolveArtifactHref(href: string, artifacts: AgentArtifact[]): string | undefined {
  const cleanHref = href.trim();
  if (!cleanHref || cleanHref.startsWith("http://") || cleanHref.startsWith("https://") || cleanHref.startsWith("/api/")) {
    return undefined;
  }
  const normalized = decodeURIComponent(cleanHref.split(/[?#]/)[0] ?? cleanHref).split("/").pop();
  const artifact = artifacts.find((candidate) => candidate.filename === normalized);
  return artifact?.url;
}
