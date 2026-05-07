import { Inject, Injectable } from "@nestjs/common";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolBuildRequestInput, ToolBuildRequestStore } from "../../../tools/toolBuildRequestStore.js";
import type { ToolMetadataStore } from "../../../tools/toolMetadataStore.js";
import {
  SECRET_HANDLE_STORE,
  TOOL_BUILD_REQUEST_STORE,
  TOOL_METADATA_STORE,
} from "../../persistence/tokens.js";

@Injectable()
export class ToolBuildInputFinalizerService {
  constructor(
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_BUILD_REQUEST_STORE) private readonly buildRequests: ToolBuildRequestStore | undefined,
    @Inject(SECRET_HANDLE_STORE) private readonly secrets: SecretHandleStore | undefined,
  ) {}

  async finalize(input: ToolBuildRequestInput): Promise<ToolBuildRequestInput> {
    return this.assignGeneratedToolName(
      await this.validateContextualTarget(await this.attachInlineCredentialHandle(input)),
    );
  }

  async attachInlineCredentialHandle(input: ToolBuildRequestInput): Promise<ToolBuildRequestInput> {
    const credentialSource = input.credentialNotes?.trim() ? input.credentialNotes : input.reason;
    const inlineSecret = extractInlineCredentialSecret(credentialSource);
    if (!inlineSecret) return input;

    const handle = await this.ensureInlineCredentialSecret({
      ...input,
      credentialNotes: credentialSource,
    });
    return {
      ...input,
      reason: redactInlineCredential(input.reason, inlineSecret),
      taskSummary: redactOptionalInlineCredential(input.taskSummary, inlineSecret),
      feedback: redactOptionalInlineCredential(input.feedback, inlineSecret),
      credentialHandles: handle ? [handle] : input.credentialHandles,
      credentialNotes: handle
        ? `Credential material was stored in ${handle}; raw operator notes were redacted before queueing.`
        : redactOptionalInlineCredential(input.credentialNotes, inlineSecret),
    };
  }

  async validateContextualTarget(input: ToolBuildRequestInput): Promise<ToolBuildRequestInput> {
    if (!input.replacesToolName || !this.metadata) return input;

    const tools = await this.metadata.list();
    const current = tools.find((tool) => tool.name === input.replacesToolName);
    const text = [input.reason, input.feedback, input.taskSummary].join(" ");
    const currentScore = current ? scoreToolTargetMatch(current, text) : 0;
    const best = tools
      .map((tool) => ({ tool, score: scoreToolTargetMatch(tool, text) }))
      .filter((item) => item.tool.name !== input.replacesToolName)
      .sort((a, b) => b.score - a.score)[0];

    const clearlyWrongSelectedTool =
      best && best.score >= 4 && currentScore <= 1 && best.score >= currentScore + 4;
    if (clearlyWrongSelectedTool) {
      throw new Error(
        `Selected tool ${input.replacesToolName} does not appear to match this request. ` +
          `The text looks closer to ${best.tool.name}. No tool build request was created; ` +
          `open the matching tool/span or rewrite the feedback for ${input.replacesToolName}.`,
      );
    }

    return input;
  }

  async assignGeneratedToolName(input: ToolBuildRequestInput): Promise<ToolBuildRequestInput> {
    if (input.desiredToolName?.trim()) return input;

    const baseName = generatedToolNameFromCapability(input.capability);
    const usedNames = new Set<string>();
    for (const tool of (await this.metadata?.list()) ?? []) {
      usedNames.add(tool.name);
    }
    for (const request of (await this.buildRequests?.list(500)) ?? []) {
      if (request.contract?.toolName) usedNames.add(request.contract.toolName);
      if (request.desiredToolName) usedNames.add(request.desiredToolName);
    }

    let candidate = baseName;
    for (let index = 2; usedNames.has(candidate); index += 1) {
      candidate = `${baseName}.${index}`;
    }
    return {
      ...input,
      desiredToolName: candidate,
    };
  }

  private async ensureInlineCredentialSecret(
    input: Pick<ToolBuildRequestInput, "capability" | "displayName" | "credentialNotes" | "credentialHandles">,
  ): Promise<string | undefined> {
    if (!input.credentialNotes?.trim() || input.credentialHandles?.length || !this.secrets) return undefined;

    const handle = secretHandleFromCapability(input.capability);
    const secretRef = extractInlineCredentialSecret(input.credentialNotes);
    if (!secretRef) return undefined;

    await this.secrets.create({
      handle,
      label: `${input.displayName ?? input.capability} credentials`,
      provider: "inline",
      secretRef,
      scopes: ["instance-local", `tool:${input.capability}`],
    });
    return handle;
  }
}

function extractInlineCredentialSecret(notes: string | undefined): string | undefined {
  const value = notes?.trim();
  if (!value) return undefined;

  const labelledPatterns = [
    /\b(?:x-api-key|api[_\s-]*key|apikey|access[_\s-]*key|token|bearer|secret|ключ)\b\s*[:=]?\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{3,})["'`]?/i,
    /\b(?:key)\b\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{3,})["'`]?/i,
  ];

  for (const pattern of labelledPatterns) {
    const match = value.match(pattern);
    const candidate = sanitizeCredentialCandidate(match?.[1]);
    if (candidate && looksLikeLabelledCredential(candidate)) return candidate;
  }

  const standalone = value.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/);
  const standaloneCandidate = sanitizeCredentialCandidate(standalone?.[0]);
  if (standaloneCandidate && looksLikeCredential(standaloneCandidate)) return standaloneCandidate;

  const compact = value.match(/\b[A-Za-z0-9._~+/=]{16,}\b/);
  const compactCandidate = sanitizeCredentialCandidate(compact?.[0]);
  if (compactCandidate && looksLikeCredential(compactCandidate)) return compactCandidate;

  return undefined;
}

function sanitizeCredentialCandidate(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .replace(/^[`'"(<[{]+|[`'")>\]},.;:]+$/g, "");
}

function redactOptionalInlineCredential(value: string | undefined, secret: string): string | undefined {
  return value === undefined ? undefined : redactInlineCredential(value, secret);
}

function redactInlineCredential(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted credential]") : value;
}

function looksLikeCredential(value: string): boolean {
  if (value.length < 5) return false;
  if (/^(should|used|use|with|as|bearer|token|secret|key|ключ)$/i.test(value)) return false;
  if (/^\d{5,}$/.test(value)) return true;
  if (/[A-Z]/.test(value) && /\d/.test(value)) return true;
  if (/[-._~+/=]/.test(value) && /\d/.test(value)) return true;
  return value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function looksLikeLabelledCredential(value: string): boolean {
  if (looksLikeCredential(value)) return true;
  if (value.length < 8) return false;
  if (/^(provided|operator|credential|credentials|secret|token|apikey|api|key)$/i.test(value)) return false;
  return /[A-Za-z]/.test(value) && /[-._~+/=]/.test(value);
}

function secretHandleFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[.:-]+$/g, "")
    .slice(0, 96) || "generated.tool";
  return `secret.${slug}`;
}

function generatedToolNameFromCapability(capability: string): string {
  const slug = capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "tool";
  return `generated.${slug.replace(/-/g, ".")}`;
}

function scoreToolTargetMatch(
  tool: {
    name: string;
    displayName?: string;
    description?: string;
    capabilities?: string[];
  },
  text: string,
): number {
  const haystack = normalizeTargetText(text);
  if (!haystack) return 0;
  const aliases = [
    tool.name,
    tool.displayName,
    tool.description,
    ...(tool.capabilities ?? []),
  ].flatMap((value) => targetTokens(value));
  return [...new Set(aliases)].reduce(
    (score, token) => score + (haystack.includes(token) ? weightTargetToken(token) : 0),
    0,
  );
}

function targetTokens(value: string | undefined): string[] {
  const normalized = normalizeTargetText(value ?? "");
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token.length >= 4 && !genericToolTargetTokens.has(token));
}

function normalizeTargetText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё@._-]+/gi, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function weightTargetToken(token: string): number {
  if (token === "telegram" || token === "whatsapp" || token === "slack") return 4;
  if (token === "browser" || token === "screenshot") return 3;
  if (token === "always" || token === "service") return 2;
  return 1;
}

const genericToolTargetTokens = new Set([
  "tool",
  "generated",
  "service",
  "adapter",
  "capability",
  "http",
  "json",
  "api",
  "with",
  "from",
  "this",
  "that",
  "request",
  "change",
  "version",
]);
