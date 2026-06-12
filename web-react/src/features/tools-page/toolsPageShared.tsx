import type { ReactNode } from "react";

import { useToolPackageRunners, type ToolCreationRecord, type ToolVersionSummary } from "@/api/tools";
import { GenericBadge } from "@/components/StatusBadge";
import type { ToolModuleMetadata } from "@/api/types";

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2">
      <p className="font-mono text-sm font-semibold">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase text-app-text-muted">{label}</p>
    </div>
  );
}


export const TOOL_RUN_EXAMPLES: Record<string, unknown> = {
  "browser.operate": {
    commands: [
      { type: "navigate", url: "https://example.com" },
      { type: "screenshot", label: "demo", maxHeight: 2000 },
      { type: "extractText", selector: "body", label: "page-text", maxLength: 1500 },
    ],
    viewport: { width: 1280, height: 800 },
    defaultTimeoutMs: 15000,
  },
  "chart.generate": {
    task: "покажи график изменения цены",
    text: '{"history":[{"timestamp":"2024-01-01","price":100},{"timestamp":"2024-01-02","price":110},{"timestamp":"2024-01-03","price":95},{"timestamp":"2024-01-04","price":130}]}',
    title: "Demo Price Chart",
    filename: "demo-chart.svg",
  },
  "market.timeseries": { symbol: "BTC", vsCurrency: "usd", days: 30 },
  "web.search": { query: "what is an agentic universal agent", limit: 5 },
  "file.read": { path: "manual-checks" },
  "file.write": { path: "manual-test/hello.txt", content: "hello from manual run\n" },
  "telegram.bot": {},
};

/**
 * Phase 13 follow-up: walk a JSON Schema and produce a structurally
 * valid example object. Recurses into nested object/array schemas,
 * uses `default` / `enum[0]` / `minimum` / `minLength` hints when
 * available, and falls back to type-driven placeholders ("example
 * string", 0, false, []) otherwise. Returns `{}` for an empty
 * schema. Pure function — easy to unit-test if it grows.
 */
export function buildSchemaExample(schema: unknown, toolName?: string): unknown {
  if (toolName && Object.prototype.hasOwnProperty.call(TOOL_RUN_EXAMPLES, toolName)) {
    return TOOL_RUN_EXAMPLES[toolName];
  }
  return buildExampleForSchema(schema);
}


export function buildPinnedRunInput(
  tool: ToolModuleMetadata,
  version: ToolVersionSummary,
): Record<string, unknown> {
  const manifest = version.packageManifest as {
    examples?: Array<{ input?: unknown }>;
    inputSchema?: unknown;
  } | undefined;
  const exampleInput = manifest?.examples?.[0]?.input ?? tool.examples?.[0]?.input;
  if (exampleInput && typeof exampleInput === "object" && !Array.isArray(exampleInput)) {
    return exampleInput as Record<string, unknown>;
  }
  const generated = buildSchemaExample(manifest?.inputSchema ?? tool.inputSchema, tool.name);
  if (generated && typeof generated === "object" && !Array.isArray(generated)) {
    return generated as Record<string, unknown>;
  }
  return {};
}

export function buildExampleForSchema(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return {};
  const schema = raw as {
    type?: string | string[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    enum?: unknown[];
    default?: unknown;
    minimum?: number;
    minLength?: number;
  };
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    // Prefer required keys first, then a small slice of optional keys for context.
    const orderedKeys = [
      ...Object.keys(props).filter((k) => required.has(k)),
      ...Object.keys(props).filter((k) => !required.has(k)),
    ];
    for (const key of orderedKeys.slice(0, 8)) {
      out[key] = buildExampleForSchema(props[key]);
    }
    return out;
  }
  if (type === "array") {
    const itemSchema = schema.items;
    return itemSchema !== undefined ? [buildExampleForSchema(itemSchema)] : [];
  }
  if (type === "number" || type === "integer") {
    if (typeof schema.minimum === "number") return schema.minimum;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "string") {
    if (typeof schema.minLength === "number" && schema.minLength > 0) {
      return "example";
    }
    return "example string";
  }
  return null;
}

/**
 * Phase 13 follow-up: manual tool runner panel. Lets the operator paste a
 * JSON `input`, click "Run", and see the exact `ToolResult` the runtime
 * would hand back to an agent. Useful for smoke-testing a fresh docker
 * build / a new version before promoting it. Pre-fills the textarea
 * with a realistic example built from the tool's declared input schema
 * (or a hand-tuned payload from `TOOL_RUN_EXAMPLES`) on mount.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatSuccessRate(successCount: number, failureCount: number): string {
  const total = successCount + failureCount;
  if (total === 0) return "n/a";
  return `${Math.round((successCount / total) * 100)}%`;
}

export function compareStringLists(active: string[], candidate: string[]): string[] {
  const activeSet = new Set(active);
  const candidateSet = new Set(candidate);
  const added = candidate.filter((item) => !activeSet.has(item)).map((item) => `+${item}`);
  const removed = active.filter((item) => !candidateSet.has(item)).map((item) => `-${item}`);
  return [...added, ...removed];
}

export function factToneClass(tone: "ok" | "warn" | "danger" | "muted"): string {
  switch (tone) {
    case "ok":
      return "text-app-accent";
    case "warn":
      return "text-app-warning";
    case "danger":
      return "text-app-danger";
    default:
      return "text-app-text-muted";
  }
}

export function nextPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return `${version}.1`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
}

export function inferCreationKindFromTool(
  tool: ToolModuleMetadata,
): "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit" {
  if (tool.packageManifest?.integration?.mode === "always-on-service") return "service-adapter";
  if (tool.startupMode === "always-on") return "service-adapter";
  const text = [tool.name, tool.description, ...(tool.capabilities ?? [])].join(" ").toLowerCase();
  if (text.includes("telegram") || text.includes("messaging") || text.includes("bot") || text.includes("always-on")) return "service-adapter";
  if (text.includes("external-action-prepare") || text.includes("prepared action draft") || text.includes("safe external action preparation")) return "external-action-prepare";
  if (text.includes("external-action-commit") || text.includes("commit executor") || text.includes("approved external action")) return "external-action-commit";
  if (text.includes("browser-operate") || text.includes("browser automation") || text.includes("dom-extraction")) return "browser-operate";
  if (text.includes("browser-screenshot") || text.includes("screenshot")) return "browser-screenshot";
  if (text.includes("web-read") || text.includes("web-extract")) return "web-read";
  if (text.includes("npm-package") || text.includes("slugify")) return "npm-default-function";
  if (text.includes("api-client") || text.includes("http") || text.includes("fetch")) return "http-json";
  return "echo";
}

export function defaultBehaviorExamplesText(
  kind: "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit",
  screenshotUrl = "https://example.com",
): string {
  if (kind === "browser-screenshot") {
    return formatBehaviorExamples([
      {
        input: { url: screenshotUrl },
        expectedContentIncludes: "Screenshot captured",
      },
    ]);
  }
  if (kind === "browser-operate") {
    return formatBehaviorExamples([
      {
        input: { url: screenshotUrl, commands: [{ action: "extractText" }, { action: "screenshot" }], prepareOnly: true },
        expectedContentIncludes: "Browser operation completed",
      },
    ]);
  }
  if (kind === "external-action-prepare") {
    return formatBehaviorExamples([
      {
        input: {
          url: screenshotUrl,
          actionType: "generic_external_action",
          commands: [{ action: "extractText" }, { action: "extractLinks" }, { action: "extractForms" }, { action: "screenshot" }],
          prepareOnly: true,
        },
        expectedContentIncludes: "Browser operation completed",
      },
    ]);
  }
  if (kind === "echo") {
    return formatBehaviorExamples([
      {
        input: { text: "ok" },
        expectedContent: "ok",
      },
    ]);
  }
  if (kind === "service-adapter") {
    return "";
  }
  return "";
}

export function formatBehaviorExamples(
  examples: Array<{
    title?: string;
    input: Record<string, unknown>;
    expectedOk?: boolean;
    expectedContent?: string;
    expectedContentIncludes?: string;
  }>,
): string {
  return JSON.stringify(examples);
}

export function parseDependencyText(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawItem of value.split(",")) {
    const item = rawItem.trim();
    if (!item) continue;
    const separator = item.lastIndexOf(":");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const versionRange = item.slice(separator + 1).trim();
    if (name && versionRange) out[name] = versionRange;
  }
  return out;
}

export function parseBehaviorExamplesText(value: string): Array<{
  title?: string;
  input: Record<string, unknown>;
  expectedOk?: boolean;
  expectedContent?: string;
  expectedContentIncludes?: string;
}> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Behavior QA examples must be a JSON array.");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Behavior QA example ${index + 1} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (!record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
      throw new Error(`Behavior QA example ${index + 1} needs an input object.`);
    }
    return {
      title: typeof record.title === "string" ? record.title : undefined,
      input: record.input as Record<string, unknown>,
      expectedOk: typeof record.expectedOk === "boolean" ? record.expectedOk : undefined,
      expectedContent: typeof record.expectedContent === "string" ? record.expectedContent : undefined,
      expectedContentIncludes: typeof record.expectedContentIncludes === "string" ? record.expectedContentIncludes : undefined,
    };
  });
}

export function formatAdapterContract(contract: NonNullable<ToolCreationRecord["strategy"]>["adapterContract"]): string {
  if (!contract) return "n/a";
  const callable = contract.importStyle === "named"
    ? contract.exportName
    : contract.importStyle === "namespace"
      ? contract.memberName
      : "default export";
  return [
    contract.packageName,
    contract.importStyle,
    callable,
    contract.inputMode ? `input:${contract.inputMode}` : undefined,
  ].filter(Boolean).join(" · ");
}

export function compareVersionsDesc(leftVersion: string, rightVersion: string): number {
  const left = leftVersion.split(".").map((part) => Number(part) || 0);
  const right = rightVersion.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return rightVersion.localeCompare(leftVersion);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function statusTone(status?: string): "ok" | "warn" | "danger" | "muted" {
  // Phase 18: `available` = council QA blessed → solid green.
  // `loaded` = source-bundle imports → softer "warn" (yellow) so
  // the operator can tell the runtime accepts it but it hasn't
  // been verified by QA yet.
  if (status === "available") return "ok";
  if (status === "loaded") return "warn";
  if (status === "disabled") return "muted";
  if (status === "failed") return "danger";
  return "muted";
}

export function creationStatusTone(status?: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "registered") return "ok";
  if (status === "requested" || status === "building") return "warn";
  if (status === "qa_failed" || status === "failed") return "danger";
  return "muted";
}

export function serviceTone(status?: string): "ok" | "warn" | "danger" | "muted" | "running" {
  if (status === "running") return "running";
  if (status === "starting") return "warn";
  if (status === "failed") return "danger";
  return "muted";
}

export function InputSchemaSummary({
  schema,
}: {
  schema?: ToolModuleMetadata["inputSchema"];
}) {
  const properties =
    schema && typeof schema === "object" && schema !== null
      ? ((schema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  const required = new Set(
    (schema && typeof schema === "object" && schema !== null
      ? ((schema as { required?: string[] }).required ?? [])
      : []) ?? [],
  );
  const entries = Object.entries(properties);

  return (
    <details className="rounded border border-app-border bg-app-surface px-2 py-1.5 open:bg-app-surface-2" open>
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        Input schema {entries.length > 0 ? `(${entries.length} field${entries.length === 1 ? "" : "s"})` : "(no declared properties)"}
      </summary>
      {entries.length === 0 ? (
        <p className="mt-1 text-[11px] text-app-text-muted">
          This tool doesn't declare an input schema. Pass any JSON object and the runtime will forward it as-is.
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1 text-[11px]">
          {entries.map(([key, raw]) => {
            const def = raw as {
              type?: string | string[];
              description?: string;
              enum?: unknown[];
              minLength?: number;
              minimum?: number;
              maximum?: number;
              default?: unknown;
            };
            const type = Array.isArray(def?.type) ? def.type.join("|") : def?.type ?? "any";
            const constraints: string[] = [];
            if (Array.isArray(def?.enum) && def.enum.length > 0) {
              constraints.push(`enum: ${def.enum.map((v) => JSON.stringify(v)).join(", ")}`);
            }
            if (def?.minLength !== undefined) constraints.push(`minLen ${def.minLength}`);
            if (def?.minimum !== undefined) constraints.push(`min ${def.minimum}`);
            if (def?.maximum !== undefined) constraints.push(`max ${def.maximum}`);
            if (def?.default !== undefined) {
              constraints.push(`default: ${JSON.stringify(def.default).slice(0, 40)}`);
            }
            return (
              <li key={key} className="flex flex-col rounded bg-app-surface px-2 py-1">
                <span className="font-mono">
                  {key}
                  {required.has(key) ? <span className="ml-1 text-app-warning">*</span> : null}
                  <span className="ml-2 text-app-text-muted">: {type}</span>
                </span>
                {def?.description ? <span className="text-app-text-muted">{def.description}</span> : null}
                {constraints.length > 0 ? <span className="text-app-text-muted">{constraints.join(" · ")}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

export function PackageRunnersPanel({ runners }: { runners: ReturnType<typeof useToolPackageRunners>["data"] }) {
  if (!runners?.length) return null;
  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        Package runners
      </h3>
      <ul className="mt-2 space-y-1">
        {runners.map((runner) => (
          <li key={runner.name} className="rounded-md border border-app-border bg-app-surface-2 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">{runner.name}</span>
              <GenericBadge tone={runner.status === "available" ? "ok" : runner.status === "failed" ? "danger" : "muted"}>
                {runner.status}
              </GenericBadge>
            </div>
            <p className="mt-1 text-[11px] text-app-text-muted">
              {runner.packageType} · {runner.detail ?? "No detail."}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
