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

export type ModelPackageJsonPatch = {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function renderCouncilScaffold(options: {
  toolName: string;
  sanitizedName: string;
  version: string;
  toolBody: string;
  /**
   * Runtime npm packages the tool body imports — e.g. `puppeteer`,
   * `playwright`, `axios`. Phase 22 Slice E: declared either by
   * the council winner via `proposal.packages` or auto-extracted
   * from `import` statements in `toolBody`. Written into the
   * generated package.json so the bundle runner can `npm install`
   * them into the tool's own node_modules without leaking deps
   * into the main app image.
   */
  dependencies?: Record<string, string>;
  /**
   * Phase 24 Slice B — model-emitted package.json overrides.
   * The implement / repair prompt now lets the LLM include a
   * `packageJson` block in its response. We treat that as the
   * source of truth for runtime concerns: dependencies (with
   * pinned versions the model chose), scripts.postinstall
   * (e.g. `playwright install chromium` for tools that need
   * a browser binary), and extra devDependencies. Merged into
   * the scaffold's canonical defaults — the model can OVERRIDE
   * but cannot REMOVE the scaffold's build/start scripts or the
   * tsc devDependencies. Auto-extracted `dependencies` stay as
   * a safety net when the model forgets to declare a package.
   */
  modelPackageJson?: ModelPackageJsonPatch;
}): ScaffoldFile[] {
  const { toolName, sanitizedName, version, toolBody, dependencies, modelPackageJson } = options;
  return [
    { path: COUNCIL_TOOL_BODY_PATH(sanitizedName), content: toolBody },
    { path: "index.ts", content: indexFile(sanitizedName) },
    { path: "runtime/server.ts", content: RUNTIME_SERVER },
    { path: "src/tools/tool.ts", content: TOOL_TYPES },
    {
      path: "package.json",
      content: packageJsonFile(toolName, version, dependencies, modelPackageJson),
    },
    { path: "tsconfig.json", content: TSCONFIG },
  ];
}

function indexFile(sanitizedName: string): string {
  return `export { tool } from "./src/tools/generated/${sanitizedName}Tool.js";\n`;
}

function packageJsonFile(
  toolName: string,
  version: string,
  dependencies?: Record<string, string>,
  modelPackageJson?: ModelPackageJsonPatch,
): string {
  // Canonical defaults — the scaffold's contract with the
  // bundle runner. These two scripts cannot be removed (the
  // runner expects `dist/runtime/server.js` to exist after
  // build) but the model CAN add more, e.g. postinstall.
  const scripts: Record<string, string> = {
    build: "tsc -p tsconfig.json",
    start: "node dist/runtime/server.js",
    ...(modelPackageJson?.scripts ?? {}),
    // Re-pin the immutables LAST so the model can't accidentally
    // overwrite them with a typo'd version.
    build_immutable: undefined as unknown as string,
  };
  delete scripts.build_immutable;
  scripts.build = "tsc -p tsconfig.json";
  scripts.start = "node dist/runtime/server.js";

  // dependencies: model's pinned versions take precedence over
  // auto-extracted "latest" fallbacks. The auto-extractor stays
  // as a safety net for packages the model forgot to declare.
  const mergedDependencies: Record<string, string> = {
    ...(dependencies ?? {}),
    ...(modelPackageJson?.dependencies ?? {}),
  };

  const devDependencies: Record<string, string> = {
    "@types/node": "^20.12.12",
    typescript: "^5.6.3",
    ...(modelPackageJson?.devDependencies ?? {}),
  };

  const pkg: Record<string, unknown> = {
    name: toolName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    version,
    private: true,
    type: "module",
    scripts,
    devDependencies,
  };
  if (Object.keys(mergedDependencies).length > 0) {
    pkg.dependencies = mergedDependencies;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Extract bare-specifier imports from a tool body so the scaffold
 * can declare them as dependencies.
 *
 * Handles all three import forms TypeScript/JS emit:
 *   - `import x from "pkg"`
 *   - `import { y } from "pkg"`
 *   - `import "pkg"` (side-effect import)
 *   - `import * as z from "pkg"`
 *   - `const x = require("pkg")`
 *
 * Returns the resolved npm package name (e.g. `@scope/pkg/sub` →
 * `@scope/pkg`, `pkg/lib/foo` → `pkg`), filtered to bare specifiers
 * (no relative `./`, no `node:` builtins). Returns a stable
 * (alphabetically sorted) array so reruns are deterministic.
 */
export function extractToolBodyImports(toolBody: string): string[] {
  const found = new Set<string>();
  // ES import statements: `import ... from "pkg"` OR `import "pkg"`
  const importRegex = /import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g;
  // CommonJS-style require, just in case the LLM emitted any.
  const requireRegex = /require\(\s*["']([^"']+)["']\s*\)/g;
  for (const regex of [importRegex, requireRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(toolBody)) !== null) {
      const specifier = match[1]!;
      if (!specifier) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (specifier.startsWith("node:")) continue;
      // Drop subpath: `pkg/lib/foo` → `pkg`. `@scope/pkg/sub` → `@scope/pkg`.
      const parts = specifier.split("/");
      const pkg = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      if (pkg) found.add(pkg);
    }
  }
  return Array.from(found).sort();
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
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
      // Phase 22 Slice E — include tool name + version in every
      // health response so the operator can sanity-check "which
      // version is the runtime actually serving" from the outside
      // without grepping logs. Useful especially when council
      // rework produced multiple versions and a stale process is
      // still bound to the port.
      response.end(JSON.stringify({ ...health, tool: tool.name, version: tool.version }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/version") {
      // Tiny convenience endpoint mirroring the /health version
      // field — easier for curl checks where the operator does not
      // care about the rest of the health payload.
      response.statusCode = 200;
      response.end(JSON.stringify({ tool: tool.name, version: tool.version }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/probe") {
      // Phase 24 Slice B step 2 — per-dependency import probe.
      // GET sibling of the magic \`{__probe: true}\` POST /run input.
      // Same logic, different transport: handy for ad-hoc curl
      // checks while the subprocess is alive.
      const probe = await probeDeclaredDependencies();
      response.statusCode = 200;
      response.end(JSON.stringify(probe));
      return;
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const body = await readJsonBody(request);
      const input = asRecord(body.input);
      // Phase 24 Slice B step 2 — magic install-probe input.
      // \`{__probe: true}\` short-circuits the tool body and runs a
      // per-dependency dynamic-import probe instead. The adapter's
      // \`probeRegisteredTool\` uses this to verify EVERY declared
      // top-level dep loads cleanly inside the subprocess (catches
      // lazy-imported deps that wouldn't crash module evaluation
      // but would crash on the first real /run call).
      //
      // Returning the probe result through /run instead of adding a
      // POST /probe lets the existing source-bundle HTTP runner
      // surface install-shape failures without new plumbing — the
      // runner already does cold-start + waitForHealthyRuntime +
      // single POST /run + teardown, so a probe call is just one
      // such cycle with a special payload.
      if (input.__probe === true) {
        const probe = await probeDeclaredDependencies();
        response.statusCode = 200;
        response.end(JSON.stringify({
          ok: probe.ok,
          content: probe.detail,
          data: { tool: tool.name, version: tool.version, ...probe },
        }));
        return;
      }
      try {
        const result = await tool.run(input, asRecord(body.context));
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
  // Phase 22 Slice E — emit version on startup so docker-logs (or
  // whichever process supervises the bundle) can answer "which
  // version is running right now?" without checking the DB or
  // filesystem layout. Matches the existing structured-log
  // convention used elsewhere in the runtime.
  console.log(
    JSON.stringify({
      event: "tool-runtime-listening",
      tool: tool.name,
      version: tool.version,
      port,
    }),
  );
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

type ProbeResult = {
  ok: boolean;
  detail: string;
  declaredDeps: string[];
  broken: Array<{ name: string; error: string }>;
};

async function probeDeclaredDependencies(): Promise<ProbeResult> {
  // Phase 24 Slice B step 2 — per-dependency dynamic-import probe.
  // Reads the bundle's own package.json (NOT a hardcoded list — the
  // model owns its own deps via the council's packageJson block) and
  // tries to import each top-level runtime dependency. Reports
  // per-package success / failure so the repair LLM can swap a
  // typosquatter / wrong-name package surgically instead of guessing.
  //
  // Note: reaching this code at all means the tool body's TOP-LEVEL
  // imports already loaded cleanly (the module graph evaluated up to
  // the server.ts createServer() call). The probe's primary value is
  // for deps declared but NOT imported top-level — those would
  // otherwise hide until a specific code path runs at first /run.
  // It is ALSO a useful sanity check for ESM/CJS interop bugs that
  // \`tsc\` cannot detect statically. Always idempotent and side-effect
  // free; ok to call as often as needed.
  let declaredDeps: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/runtime/server.js → package root is two dirs up.
    const packageRoot = resolve(here, "..", "..");
    const pkgJsonText = await readFile(resolve(packageRoot, "package.json"), "utf8");
    const pkgJson = JSON.parse(pkgJsonText) as { dependencies?: Record<string, string> };
    declaredDeps = Object.keys(pkgJson.dependencies ?? {});
  } catch (err) {
    return {
      ok: false,
      detail: \`probe: could not read package.json: \${err instanceof Error ? err.message : String(err)}\`,
      declaredDeps: [],
      broken: [],
    };
  }
  const broken: Array<{ name: string; error: string }> = [];
  for (const name of declaredDeps) {
    try {
      await import(name);
    } catch (err) {
      broken.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Quiet reference so an unused import in some scaffold permutations
  // does not trip strict tsc. \`pathToFileURL\` is imported at the
  // top in case a future probe step needs to import an on-disk file
  // by URL; keep it tracked.
  void pathToFileURL;
  return {
    ok: broken.length === 0,
    detail:
      broken.length === 0
        ? \`probe: \${declaredDeps.length} declared dep(s) imported cleanly\`
        : \`probe: \${broken.length}/\${declaredDeps.length} declared dep(s) failed to import: \${broken.map((b) => b.name).join(", ")}\`,
    declaredDeps,
    broken,
  };
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
