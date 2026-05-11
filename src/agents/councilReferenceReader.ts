/**
 * Phase 14 / Phase E follow-up: pull text out of operator-attached
 * reference docs (OpenAPI specs, API READMEs, PDFs, etc.) so the
 * council can read them when designing a new tool.
 *
 * Architectural principle: we don't bake a parser per MIME type into
 * the core. Text-like formats (utf-8 text/markdown/yaml/json/openapi)
 * decode in place because they're trivial; binary formats require a
 * dedicated reader TOOL that the council either already has or has
 * to build first. Without that tool the council halts the run with a
 * clear "needs `reads:<mime>` tool" signal — the operator (or the
 * autonomous tool-rework loop) is then expected to build it.
 *
 * Returns:
 *   - `texts`: the resolved reference-doc texts (caller embeds these
 *     into ToolBuildContext.referenceDocs and on into the prompts).
 *   - `missing`: references that had no reader tool — the run should
 *     short-circuit with `waiting_tool_rework` and let the operator
 *     act on each missing tool entry.
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/tool.js";

/** Operator-supplied attachment, decoded from the API request body. */
export type ReferenceAttachment = {
  filename: string;
  mimeType: string;
  /** Raw bytes (already base64-decoded by the caller). */
  bytes: Buffer;
};

/** Resolved reference-doc text the council can read. */
export type ReferenceDoc = {
  filename: string;
  mimeType: string;
  content: string;
  /** Which path produced the text — direct utf-8 decode, or tool-name. */
  source: "utf8-decode" | "tool";
  readerToolName?: string;
};

/** Reference we couldn't read because no reader tool exists yet. */
export type MissingReader = {
  filename: string;
  mimeType: string;
  /** The capability tag the council searched for. */
  capability: string;
  reason: string;
};

export type ResolveReferencesResult = {
  texts: ReferenceDoc[];
  missing: MissingReader[];
};

/** MIME types we can decode directly without a tool. Anything outside
 *  this set must go through a dedicated reader tool. The matcher is
 *  prefix-aware so `text/anything` and OpenAPI variants work too. */
const DIRECT_DECODE_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/openapi",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
];

export function canDecodeDirectly(mimeType: string): boolean {
  const normalized = (mimeType || "").toLowerCase().split(";")[0]?.trim() ?? "";
  return DIRECT_DECODE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Capability tag a reader tool must declare. */
export function readerCapabilityFor(mimeType: string): string {
  const base = (mimeType || "").toLowerCase().split(";")[0]?.trim() ?? "application/octet-stream";
  return `reads:${base}`;
}

/** Look up any tool whose capabilities include the right `reads:<mime>` tag.
 *  We don't require an exact MIME match by tool name — any tool that
 *  advertises the capability is fair game. */
export function findReaderTool(registry: ToolRegistry, mimeType: string): Tool | undefined {
  const cap = readerCapabilityFor(mimeType);
  for (const tool of registry.list()) {
    if (tool.capabilities?.includes(cap)) return tool;
    // Wildcard reader: a tool advertising `reads:*` claims it can
    // handle any MIME (e.g. a generic file.read backed by Apache Tika).
    if (tool.capabilities?.includes("reads:*")) return tool;
  }
  return undefined;
}

/**
 * Resolve every attached reference to its text content.
 *
 * The reader-tool invocation contract: we call `tool.run({ filename,
 * mimeType, contentBase64 })` and expect `{ ok: true, content: string }`.
 * Anything else (ok=false, missing content, exception) is reported as
 * "missing" so the council surfaces the gap to the operator.
 */
export async function resolveReferences(options: {
  attachments: ReferenceAttachment[];
  registry: ToolRegistry;
}): Promise<ResolveReferencesResult> {
  const { attachments, registry } = options;
  const texts: ReferenceDoc[] = [];
  const missing: MissingReader[] = [];

  for (const attachment of attachments) {
    if (canDecodeDirectly(attachment.mimeType)) {
      texts.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: attachment.bytes.toString("utf8"),
        source: "utf8-decode",
      });
      continue;
    }

    const reader = findReaderTool(registry, attachment.mimeType);
    if (!reader) {
      missing.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        capability: readerCapabilityFor(attachment.mimeType),
        reason:
          `No registered tool advertises capability "${readerCapabilityFor(attachment.mimeType)}" ` +
          `(needed to read ${attachment.filename}). Build one through Tool Builds first, ` +
          `then re-run this council build.`,
      });
      continue;
    }

    try {
      const result = await reader.run(
        {
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          contentBase64: attachment.bytes.toString("base64"),
        },
        { toolName: reader.name, now: new Date(), caller: "council-reference-reader" },
      );
      if (!result.ok || typeof result.content !== "string" || result.content.length === 0) {
        missing.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          capability: readerCapabilityFor(attachment.mimeType),
          reason: `Reader tool ${reader.name} returned ok=${result.ok} without usable content.`,
        });
        continue;
      }
      texts.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: result.content,
        source: "tool",
        readerToolName: reader.name,
      });
    } catch (error) {
      missing.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        capability: readerCapabilityFor(attachment.mimeType),
        reason:
          `Reader tool ${reader.name} threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { texts, missing };
}
