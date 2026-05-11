/**
 * Phase 14 / TB-005: canonical source-bundle scaffold for council-built
 * tools.
 *
 * The runtime tool registry only loads source-bundle packages whose layout
 * matches what the runners expect:
 *   - `tools/<name>/<version>/runtime/server.ts` → built to
 *     `dist/runtime/server.js` (HTTP process runner entry point).
 *   - `tools/<name>/<version>/index.ts` re-exports `tool` from the
 *     generated source file.
 *   - `tools/<name>/<version>/src/tools/tool.ts` defines the `Tool` types.
 *
 * Asking the LLM council to emit all of this verbatim has not been reliable
 * — models invent their own server shape every time. So we generate the
 * scaffold deterministically here and only let the council fill in the
 * tool body itself (`src/tools/generated/<name>Tool.ts`).
 */

/**
 * The on-disk path (relative to the package root) where the council's
 * tool body lives. We pin this so prompts can show the model exactly
 * which file to produce.
 */
export const COUNCIL_TOOL_BODY_PATH = (sanitizedName: string) =>
  `src/tools/generated/${sanitizedName}Tool.ts`;

/** Files we always overlay regardless of what the model emits. */
export type ScaffoldFile = { path: string; content: string };

export function renderCouncilScaffold(options: {
  toolName: string;
  sanitizedName: string;
  version: string;
  toolBody: string;
}): ScaffoldFile[] {
  const { toolName, sanitizedName, version, toolBody } = options;
  return [
    { path: COUNCIL_TOOL_BODY_PATH(sanitizedName), content: toolBody },
    { path: "index.ts", content: indexFile(sanitizedName) },
    { path: "runtime/server.ts", content: RUNTIME_SERVER },
    { path: "src/tools/tool.ts", content: TOOL_TYPES },
    { path: "package.json", content: packageJsonFile(toolName, version) },
    { path: "tsconfig.json", content: TSCONFIG },
  ];
}

function indexFile(sanitizedName: string): string {
  return `export { tool } from "./src/tools/generated/${sanitizedName}Tool.js";\n`;
}

function packageJsonFile(toolName: string, version: string): string {
  const pkg = {
    name: toolName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    version,
    private: true,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "node dist/runtime/server.js",
    },
    devDependencies: {
      "@types/node": "^20.12.12",
      typescript: "^5.6.3",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["index.ts", "runtime/**/*.ts", "src/**/*.ts"]
}
`;

const TOOL_TYPES = `export type ToolInput = Record<string, unknown>;

export type ToolResult = {
  ok: boolean;
  content: string;
  data?: unknown;
  artifacts?: Array<{
    filename: string;
    mimeType: string;
    contentBase64?: string;
    content?: string;
    kind?: string;
    preview?: unknown;
  }>;
};

export type ToolSchema = Record<string, unknown>;
export type ToolStartupMode = "on-demand" | "always-on" | "ephemeral";

export type ToolExecutionContext = {
  runId?: string;
  spanId?: string;
  caller?: string;
  signal?: AbortSignal;
  logger?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  resolveSecret?: (handle: string) => Promise<string | undefined> | string | undefined;
  resolveConfiguration?: (key: string, toolName?: string) => Promise<string | undefined> | string | undefined;
  [key: string]: unknown;
};

export type ToolServiceContext = ToolExecutionContext & {
  toolName: string;
  now: Date;
  signal: AbortSignal;
};

export type ToolServiceHandle = {
  stop?: () => Promise<void> | void;
  healthcheck?: () => Promise<{ ok: boolean; detail: string }>;
};

export type Tool = {
  name: string;
  displayName?: string;
  version: string;
  description: string;
  capabilities: string[];
  startupMode?: ToolStartupMode;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  healthcheck?: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
  run: (input: ToolInput, context?: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
  startService?: (context: ToolServiceContext) => Promise<ToolServiceHandle> | ToolServiceHandle;
  stopService?: (context?: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
};
`;

const RUNTIME_SERVER = `import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { tool } from "../index.js";

type JsonRecord = Record<string, unknown>;

const port = Number(process.env.PORT ?? "8080");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && url.pathname === "/health") {
      const health = tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: "No healthcheck registered." };
      response.statusCode = health.ok ? 200 : 503;
      response.end(JSON.stringify(health));
      return;
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const body = await readJsonBody(request);
      try {
        const result = await tool.run(asRecord(body.input), asRecord(body.context));
        // ALWAYS return HTTP 200 when tool.run() returned a structured
        // response, regardless of result.ok. ok=false is a normal
        // domain-level signal ("the tool reports the action did not
        // succeed") — not an HTTP error. Returning 500 here caused the
        // runner to drop the structured payload and report
        // "External tool runtime call failed with HTTP 500", masking
        // the actual reason from QA + repair loops.
        response.statusCode = 200;
        response.end(JSON.stringify(result));
      } catch (err) {
        // tool.run threw — turn it into a structured ok=false so the
        // oracle can still judge it and the repair loop can act on
        // the error message rather than getting "HTTP 500".
        response.statusCode = 200;
        response.end(JSON.stringify({
          ok: false,
          content: \`Tool threw: \${err instanceof Error ? err.message : String(err)}\`,
        }));
      }
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: "Not found" }));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "tool-runtime-listening", tool: tool.name, port }));
});

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return asRecord(parsed);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
`;

/** Best-effort extraction of the tool body the model emitted. */
export function extractToolBody(
  files: ReadonlyArray<{ path: string; content: string }>,
  sanitizedName: string,
): string | undefined {
  if (files.length === 0) return undefined;

  // 1. Exact-path hit on the canonical location.
  const canonical = COUNCIL_TOOL_BODY_PATH(sanitizedName);
  const direct = files.find((file) => file.path === canonical);
  if (direct) return direct.content;

  // 2. Any TS file under src/tools/generated/.
  const nested = files.find((file) =>
    file.path.replace(/^\.\//, "").startsWith("src/tools/generated/") && file.path.endsWith(".ts"),
  );
  if (nested) return nested.content;

  // 3. Any TS file containing `export const tool` — the contract marker.
  const byMarker = files.find(
    (file) => file.path.endsWith(".ts") && /export\s+const\s+tool\b/.test(file.content),
  );
  if (byMarker) return byMarker.content;

  return undefined;
}
