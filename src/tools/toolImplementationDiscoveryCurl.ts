import type { ToolBehaviorExample } from "./toolCreationStore.js";
import type { ToolIntegrationContract, ToolIntegrationOperation } from "./toolIntegrationContract.js";
import { cleanReadmeExpected, firstTextMatch } from "./toolImplementationDiscoveryNpmReadme.js";

export function inferCurlBehaviorExamples(text: string): ToolBehaviorExample[] {
  const examples: ToolBehaviorExample[] = [];
  const blocks = text.match(/curl\s+[\s\S]{0,1600}?(?=\n\s*(?:curl|```|#{1,6}\s|$))/giu) ?? [];
  for (const block of blocks.slice(0, 5)) {
    const url = firstCurlUrl(block);
    if (!url) continue;
    const method = firstTextMatch(block, /(?:-X|--request)\s+([A-Z]+)/i)?.toUpperCase()
      ?? (/(?:--data|-d)\s+/i.test(block) ? "POST" : "GET");
    const bodyLiteral = firstTextMatch(block, /(?:--data-raw|--data|-d)\s+(['"])([\s\S]{1,600}?)\1/i, 2);
    const body = bodyLiteral ? parseJsonLike(bodyLiteral) : undefined;
    const expected = firstTextMatch(block, /(?:=>|#\s*returns?:?|#\s*=>)\s*([^\n]{1,180})/i);
    examples.push({
      title: `cURL ${method} ${safeUrlPath(url)}`,
      input: {
        method,
        url,
        ...(body !== undefined ? { body } : {}),
      },
      expectedOk: true,
      ...(expected ? { expectedContentIncludes: cleanReadmeExpected(expected) ?? expected.trim() } : { expectedDataPath: "status" }),
    });
  }
  return examples;
}

export function inferCurlIntegrationContract(text: string): ToolIntegrationContract | undefined {
  const examples = inferCurlBehaviorExamples(text);
  if (examples.length === 0) return undefined;
  return {
    schemaVersion: "agentic.tool-integration.v1",
    mode: "run-on-demand",
    protocol: "http-api",
    auth: /\b(authorization|bearer|api[-_ ]?key|x-api-key)\b/i.test(text)
      ? {
          type: /\bbearer\b/i.test(text) ? "bearer-token" : "api-key",
          requiredSecretHandles: ["secret.api.integration"],
          notes: "Credential literals from cURL examples are not copied into generated source.",
        }
      : { type: "none" },
    operations: examples.slice(0, 10).map((example, index): ToolIntegrationOperation => {
      const input = example.input ?? {};
      return {
        name: `curl_example_${index + 1}`,
        direction: "outbound-request",
        method: typeof input.method === "string" ? input.method : undefined,
        path: typeof input.url === "string" ? safeUrlPath(input.url) : undefined,
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            body: { type: "object" },
          },
        },
      };
    }),
    callbackStrategy: "none",
    notes: ["Derived from supplied cURL examples."],
  };
}

function firstCurlUrl(block: string): string | undefined {
  const quoted = firstTextMatch(block, /['"](https?:\/\/[^'"\s]+)['"]/i);
  if (quoted) return quoted;
  return firstTextMatch(block, /\b(https?:\/\/[^\s\\'"]+)/i);
}

function safeUrlPath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname || "/";
  } catch {
    return value.slice(0, 80);
  }
}

function parseJsonLike(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
