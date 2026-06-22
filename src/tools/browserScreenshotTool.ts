import { BrowserOperateHttpTool } from "./browserOperateHttpTool.js";
import { Tool, ToolInput, ToolResult } from "./tool.js";

export class BrowserScreenshotTool implements Tool {
  readonly name = "browser.screenshot";
  readonly version = "1.0.0";
  readonly description =
    "Captures proof screenshots through browser.operate using viewport-sized captures focused on the requested page or selector.";
  readonly capabilities = ["browser-screenshot", "proof-screenshot", "artifact-generation", "web-proof"];
  readonly startupMode = "on-demand" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", minLength: 1 },
      selector: { type: "string" },
      focusText: { type: "string" },
      filename: { type: "string" },
      fullPage: { type: "boolean", default: false },
      waitMs: { type: "number", minimum: 0, maximum: 30_000, default: 1000 },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", minimum: 320, maximum: 4096 },
          height: { type: "number", minimum: 240, maximum: 4096 },
        },
      },
    },
    required: ["url"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly browserOperate: Tool = new BrowserOperateHttpTool()) {}

  async healthcheck() {
    if (this.browserOperate.healthcheck) return this.browserOperate.healthcheck();
    return { ok: true, detail: "browser.screenshot delegate is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return { ok: false, content: "Missing URL." };

    const commands: Array<Record<string, unknown>> = [
      { type: "navigate", url, waitUntil: "domcontentloaded", timeoutMs: 30_000 },
      {
        type: "dismissDialogs",
        selectors: [
          "button:has-text('Accept')",
          "button:has-text('I agree')",
          "button:has-text('Consent')",
          "button:has-text('Allow all')",
          "button:has-text('Принять')",
          "button:has-text('Aceptar')",
        ],
        texts: ["Accept", "I agree", "Consent", "Allow all", "Принять", "Aceptar"],
        timeoutMs: 2500,
      },
    ];

    if (typeof input.focusText === "string" && input.focusText.trim()) {
      commands.push({ type: "waitForText", text: input.focusText.trim(), timeoutMs: 8000 });
    }
    if (typeof input.selector === "string" && input.selector.trim()) {
      commands.push({ type: "waitForSelector", selector: input.selector.trim(), timeoutMs: 8000 });
    }
    const waitMs = typeof input.waitMs === "number" ? Math.max(0, Math.min(30_000, input.waitMs)) : 1000;
    if (waitMs > 0) commands.push({ type: "wait", ms: waitMs });
    commands.push({ type: "extractText", label: "visible-page", maxLength: 8_000 });
    commands.push({
      type: "screenshot",
      label: "proof",
      fullPage: input.fullPage === true,
      maxHeight: input.fullPage === true ? 3200 : undefined,
      filename: typeof input.filename === "string" && input.filename.trim() ? input.filename.trim() : undefined,
    });

    const viewport =
      input.viewport && typeof input.viewport === "object"
        ? input.viewport
        : { width: 1365, height: 900 };

    return this.browserOperate.run({
      commands,
      viewport,
      defaultTimeoutMs: 30_000,
      maxCommands: 20,
    });
  }
}
