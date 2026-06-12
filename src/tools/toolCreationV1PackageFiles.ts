import type { ToolPackageManifest } from "./toolPackage.js";
import type { ToolCreationV1Result } from "./toolCreationV1.js";
import { renderToolSource, renderToolTest } from "./toolCreationV1GenericRenderer.js";
import { packageToolContract, renderReadme } from "./toolCreationV1PackageText.js";

export { renderReadme };

export function renderPackageFiles(input: ToolCreationV1Result["input"], manifest: Omit<ToolPackageManifest, "package">) {
  const fileBase = packageIdentifier(input.name);
  const files = [
    { path: "index.ts", content: `export { tool } from "./src/tools/generated/${fileBase}Tool.js";\n` },
    { path: "runtime/server.ts", content: runtimeServerSource() },
    { path: "src/tools/tool.ts", content: packageToolContract() },
    { path: `src/tools/generated/${fileBase}Tool.ts`, content: renderToolSource(input, manifest) },
    { path: `tests/generated/${fileBase}Tool.test.ts`, content: renderToolTest(input, fileBase) },
  ];
  if (input.kind === "npm-default-function" && input.adapterPackageName) {
    files.push({
      path: "src/types/external-package.d.ts",
      content: `declare module ${JSON.stringify(input.adapterPackageName)};\n`,
    });
  }
  return files;
}

export function runtimeServerSource(): string {
  return [
    "import { createServer } from \"node:http\";",
    "import { tool } from \"../index.js\";",
    "",
    "const port = Number(process.env.PORT ?? 8080);",
    "",
    "const server = createServer(async (request, response) => {",
    "  try {",
    "    if (request.method === \"GET\" && request.url === \"/health\") {",
    "      const health = activeServiceHandle?.healthcheck",
    "        ? await activeServiceHandle.healthcheck()",
    "        : tool.healthcheck ? await tool.healthcheck() : { ok: true, detail: \"No healthcheck registered.\" };",
    "      sendJson(response, health.ok ? 200 : 503, health);",
    "      return;",
    "    }",
    "    if (request.method === \"POST\" && request.url === \"/run\") {",
    "      const body = await readJson(request);",
    "      const input = body && typeof body === \"object\" && !Array.isArray(body) && \"input\" in body",
    "        ? (body as { input?: Record<string, unknown> }).input ?? {}",
    "        : {};",
    "      const context = body && typeof body === \"object\" && !Array.isArray(body) && \"context\" in body",
    "        ? (body as { context?: unknown }).context",
    "        : undefined;",
    "      const result = await tool.run(input, context);",
    "      sendJson(response, 200, result);",
    "      return;",
    "    }",
    "    if (request.method === \"POST\" && request.url === \"/service/start\") {",
    "      const body = await readJson(request);",
    "      const context = body && typeof body === \"object\" && !Array.isArray(body) && \"context\" in body",
    "        ? (body as { context?: unknown }).context",
    "        : undefined;",
    "      if (!tool.startService) {",
    "        sendJson(response, 200, { ok: true, detail: \"Service lifecycle accepted; no custom startService hook registered.\" });",
    "        return;",
    "      }",
    "      activeServiceHandle = (await tool.startService(context)) ?? undefined;",
    "      sendJson(response, 200, { ok: true, detail: \"Service started.\" });",
    "      return;",
    "    }",
    "    if (request.method === \"POST\" && request.url === \"/service/stop\") {",
    "      if (activeServiceHandle?.stop) await activeServiceHandle.stop();",
    "      activeServiceHandle = undefined;",
    "      sendJson(response, 200, { ok: true, detail: \"Service stopped.\" });",
    "      return;",
    "    }",
    "    sendJson(response, 404, { ok: false, detail: \"Not found\" });",
    "  } catch (error) {",
    "    sendJson(response, 500, { ok: false, content: error instanceof Error ? error.message : String(error) });",
    "  }",
    "});",
    "",
    "let activeServiceHandle: { stop?: () => Promise<void> | void; healthcheck?: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string } } | undefined;",
    "server.listen(port, \"0.0.0.0\");",
    "",
    "function readJson(request: import(\"node:http\").IncomingMessage): Promise<unknown> {",
    "  return new Promise((resolve, reject) => {",
    "    const chunks: Buffer[] = [];",
    "    request.on(\"data\", (chunk) => chunks.push(Buffer.from(chunk)));",
    "    request.on(\"error\", reject);",
    "    request.on(\"end\", () => {",
    "      const text = Buffer.concat(chunks).toString(\"utf8\");",
    "      if (!text.trim()) {",
    "        resolve({});",
    "        return;",
    "      }",
    "      try {",
    "        resolve(JSON.parse(text));",
    "      } catch (error) {",
    "        reject(error);",
    "      }",
    "    });",
    "  });",
    "}",
    "",
    "function sendJson(response: import(\"node:http\").ServerResponse, statusCode: number, payload: unknown): void {",
    "  response.writeHead(statusCode, { \"content-type\": \"application/json\" });",
    "  response.end(JSON.stringify(payload));",
    "}",
    "",
  ].join("\n");
}

export function runtimeDockerfile(input: ToolCreationV1Result["input"]): string {
  const lines = [
    "FROM node:22-alpine",
  ];
  if (input.kind === "browser-screenshot" || input.kind === "browser-operate" || input.kind === "external-action-prepare" || input.kind === "external-action-commit") {
    lines.push(
      "RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont",
      "ENV CHROMIUM_PATH=/usr/bin/chromium-browser",
    );
  }
  lines.push(
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi",
    "COPY dist ./dist",
    "EXPOSE 8080",
    "CMD [\"node\", \"dist/runtime/server.js\"]",
    "",
  );
  return lines.join("\n");
}

export function runtimePackageJson(
  input: ToolCreationV1Result["input"],
  manifest: Omit<ToolPackageManifest, "package">,
): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "node dist/runtime/server.js",
      test: "node --test \"dist/tests/**/*.test.js\"",
    },
    devDependencies: {
      "@types/node": "^20.12.12",
      typescript: "^5.6.3",
    },
    dependencies: input.dependencies,
  };
}


function packageIdentifier(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "generated-tool";
}
