import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ToolBuildAttemptContext,
  ToolBuildOutput,
  ToolBuilder,
  ToolQaRunner,
  ToolRegistrar,
} from "./toolBuildWorkflow.js";
import {
  ToolBuildQaReport,
  ToolBuildRequest,
} from "./toolBuildRequestStore.js";
import { ToolMetadataStore } from "./toolMetadataStore.js";

type GeneratedFile = {
  path: string;
  content: string;
};

type ToolBuildProviderOutput = {
  modulePath: string;
  testPath: string;
  summary: string;
  files: GeneratedFile[];
};

export type ToolBuildProvider = {
  canBuild(request: ToolBuildRequest): boolean;
  build(request: ToolBuildRequest, context?: ToolBuildAttemptContext): ToolBuildProviderOutput;
};

export class GeneratedToolFileBuilder implements ToolBuilder {
  constructor(
    private readonly providers: ToolBuildProvider[],
    private readonly projectRoot = process.cwd(),
  ) {}

  async build(request: ToolBuildRequest, context?: ToolBuildAttemptContext): Promise<ToolBuildOutput> {
    const provider = this.providers.find((item) => item.canBuild(request));
    if (!provider) {
      throw new Error(`No Tool Build provider can create capability "${request.capability}".`);
    }

    const output = provider.build(request, context);
    for (const file of output.files) {
      const absolutePath = safeProjectPath(this.projectRoot, file.path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }

    return {
      modulePath: output.modulePath,
      testPath: output.testPath,
      summary: output.summary,
    };
  }
}

export class IsolatedCommandToolQaRunner implements ToolQaRunner {
  constructor(private readonly projectRoot = process.cwd()) {}

  async run(request: ToolBuildRequest, output: ToolBuildOutput): Promise<ToolBuildQaReport> {
    const checks: string[] = [];
    const isolatedRoot = await createIsolatedQaWorkspace(this.projectRoot);
    try {
      const isolatedTestResult = await runCommand(
        "npx",
        ["tsx", "--test", output.testPath],
        isolatedRoot,
      );
      checks.push(formatCommandCheck("isolated targeted generated tool tests", isolatedTestResult));
      if (!isolatedTestResult.ok) {
        return {
          ok: false,
          summary: `Isolated generated tool tests failed for ${request.contract.toolName}.`,
          checks,
        };
      }

      const isolatedBuildResult = await runCommand("npm", ["run", "build"], isolatedRoot);
      checks.push(formatCommandCheck("isolated TypeScript build", isolatedBuildResult));
      if (!isolatedBuildResult.ok) {
        return {
          ok: false,
          summary: `Isolated TypeScript build failed for ${request.contract.toolName}.`,
          checks,
        };
      }
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }

    const testResult = await runCommand(
      "npx",
      ["tsx", "--test", output.testPath],
      this.projectRoot,
    );
    checks.push(formatCommandCheck("promotion targeted generated tool tests", testResult));
    if (!testResult.ok) {
      return {
        ok: false,
        summary: `Promotion generated tool tests failed for ${request.contract.toolName}.`,
        checks,
      };
    }

    const buildResult = await runCommand("npm", ["run", "build"], this.projectRoot);
    checks.push(formatCommandCheck("promotion TypeScript build", buildResult));
    if (!buildResult.ok) {
      return {
        ok: false,
        summary: `Promotion TypeScript build failed for ${request.contract.toolName}.`,
        checks,
      };
    }

    return {
      ok: true,
      summary: `Generated tool ${request.contract.toolName} passed isolated QA and promotion build.`,
      checks,
      artifacts: [output.modulePath, output.testPath],
    };
  }
}

export class CommandToolQaRunner extends IsolatedCommandToolQaRunner {}

export class MetadataToolRegistrar implements ToolRegistrar {
  constructor(private readonly metadataStore: ToolMetadataStore) {}

  async register(request: ToolBuildRequest, output: ToolBuildOutput): Promise<string> {
    const toolName = request.contract.toolName;
    await this.metadataStore.registerGenerated({
      name: toolName,
      version: "1.0.0",
      description: request.contract.description,
      capabilities: [request.capability, "browser-screenshot", "artifact-generation"],
      startupMode: request.contract.startupMode,
      inputSchema: request.contract.inputSchema,
      outputSchema: request.contract.outputSchema,
      modulePath: output.modulePath,
      testPath: output.testPath,
    });

    return toolName;
  }
}

export class BrowserScreenshotToolBuildProvider implements ToolBuildProvider {
  canBuild(request: ToolBuildRequest): boolean {
    const text = [
      request.capability,
      request.contract.capability,
      request.contract.toolName,
      request.reason,
    ].join(" ");

    return /browser[-.\s]?screenshot|screenshot|screen[-.\s]?capture/i.test(text);
  }

  build(request: ToolBuildRequest): ToolBuildProviderOutput {
    const modulePath = request.contract.modulePath;
    const testPath = request.contract.testPath;
    const toolName = request.contract.toolName;
    const capability = request.capability;

    return {
      modulePath,
      testPath,
      summary: `Generated Playwright-based browser screenshot tool ${toolName}.`,
      files: [
        { path: modulePath, content: browserScreenshotToolSource(toolName, capability) },
        { path: testPath, content: browserScreenshotToolTestSource(modulePath, toolName) },
      ],
    };
  }
}

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  output: string;
};

function safeProjectPath(projectRoot: string, filePath: string): string {
  if (filePath.includes("..") || filePath.startsWith("/") || filePath.includes("\\")) {
    throw new Error(`Generated file path must be project-relative: ${filePath}`);
  }

  const absolutePath = resolve(projectRoot, filePath);
  const relativePath = relative(resolve(projectRoot), absolutePath);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Generated file path escapes project root: ${filePath}`);
  }

  return absolutePath;
}

async function createIsolatedQaWorkspace(projectRoot: string): Promise<string> {
  const isolatedRoot = await mkdtemp(resolve(tmpdir(), "agentic-tool-qa-"));
  const entries = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
  ];

  for (const entry of entries) {
    await cp(resolve(projectRoot, entry), resolve(isolatedRoot, entry));
  }
  await cp(resolve(projectRoot, "src"), resolve(isolatedRoot, "src"), { recursive: true });
  await cp(resolve(projectRoot, "tests"), resolve(isolatedRoot, "tests"), { recursive: true });

  const nodeModules = resolve(projectRoot, "node_modules");
  if (existsSync(nodeModules)) {
    await symlink(nodeModules, resolve(isolatedRoot, "node_modules"), "dir");
  }

  return isolatedRoot;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env },
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, exitCode: null, output: `Command timed out after ${timeoutMs} ms.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, exitCode: null, output: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8").slice(-6000);
      resolve({ ok: exitCode === 0, exitCode, output });
    });
  });
}

function formatCommandCheck(label: string, result: CommandResult): string {
  const status = result.ok ? "passed" : "failed";
  const output = result.output.trim().replace(/\s+/g, " ").slice(0, 500);
  return `${label} ${status} with exit ${result.exitCode ?? "none"}${output ? `: ${output}` : ""}`;
}

function browserScreenshotToolSource(toolName: string, capability: string): string {
  return `import { chromium } from "@playwright/test";
import { Tool, ToolInput, ToolResult } from "../tool.js";

type ScreenshotData = {
  artifact: {
    filename: string;
    mimeType: "image/png";
    contentBase64: string;
    description: string;
  };
  url: string;
};

export const tool: Tool = {
  name: ${JSON.stringify(toolName)},
  version: "1.0.0",
  description: "Captures a browser screenshot and returns it as an artifact payload.",
  capabilities: [${JSON.stringify(capability)}, "browser-screenshot", "artifact-generation"],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      filename: { type: "string" },
      fullPage: { type: "boolean" }
    },
    required: ["url"]
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object", properties: { artifact: { type: "object" }, url: { type: "string" } } }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Browser screenshot tool module is importable." };
  },
  async run(input: ToolInput): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, content: "browser screenshot requires a url input." };

    const parsed = parseHttpUrl(url);
    if (!parsed.ok) return { ok: false, content: parsed.error };

    const filename = typeof input.filename === "string" && input.filename.trim()
      ? safeFilename(input.filename)
      : screenshotFilename(parsed.url);
    const fullPage = typeof input.fullPage === "boolean" ? input.fullPage : true;
    const launchOptions = process.env.CHROMIUM_PATH
      ? { headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] }
      : { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };

    let browser;
    try {
      browser = await chromium.launch(launchOptions);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);
      const buffer = await page.screenshot({ type: "png", fullPage });
      const data: ScreenshotData = {
        artifact: {
          filename,
          mimeType: "image/png",
          contentBase64: buffer.toString("base64"),
          description: "Browser screenshot captured from " + parsed.url
        },
        url: parsed.url
      };

      return {
        ok: true,
        content: "Captured browser screenshot for " + parsed.url + ".",
        data
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Browser screenshot failed."
      };
    } finally {
      await browser?.close();
    }
  }
};

export default tool;

function parseHttpUrl(value: string): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http and https URLs are supported." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}

function screenshotFilename(url: string): string {
  const parsed = new URL(url);
  const slug = [parsed.hostname, parsed.pathname]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return (slug || "browser-page") + "-screenshot.png";
}

function safeFilename(value: string): string {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  return trimmed.endsWith(".png") ? trimmed : trimmed + ".png";
}
`;
}

function browserScreenshotToolTestSource(modulePath: string, toolName: string): string {
  const importPath = relative("tests/generated", modulePath).replace(/\\/g, "/").replace(/\.ts$/, ".js");

  return `import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tool } from "${importPath.startsWith(".") ? importPath : `./${importPath}`}";

test("${toolName} exposes a valid generated tool contract", async () => {
  const health = await tool.healthcheck?.();

  assert.equal(tool.name, ${JSON.stringify(toolName)});
  assert.ok(tool.capabilities.includes("browser-screenshot"));
  assert.equal(health?.ok, true);
});

test("${toolName} rejects invalid URLs without launching a browser", async () => {
  const result = await tool.run({ url: "notaurl" });

  assert.equal(result.ok, false);
  assert.match(result.content, /Invalid URL/);
});

test("${toolName} captures a local page screenshot artifact", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>smoke</title><main style='font: 24px sans-serif'>Browser screenshot smoke</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await tool.run({
      url: "http://127.0.0.1:" + address.port + "/",
      filename: "smoke.png",
      fullPage: false
    });
    const data = result.data as { artifact?: { contentBase64?: string; mimeType?: string } } | undefined;

    assert.equal(result.ok, true);
    assert.equal(data?.artifact?.mimeType, "image/png");
    assert.ok(Buffer.from(data?.artifact?.contentBase64 ?? "", "base64").byteLength > 1000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
`;
}
