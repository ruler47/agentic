import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";

class SequenceLlm {
  calls = 0;
  messagesByCall: Message[][] = [];
  optionsByCall: unknown[] = [];

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(messages: Message[], _tools: LlmToolSchema[], options?: unknown): Promise<LlmToolReply> {
    this.messagesByCall.push(messages);
    this.optionsByCall.push(options);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("BaseAgent uses bounded current fact fast path for narrow live facts", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  let readCalls = 0;
  let screenshotCalls = 0;
  registerCurrentFactTools(registry, {
    onSearch: () => { searchCalls += 1; },
    onRead: () => { readCalls += 1; },
    onScreenshot: () => { screenshotCalls += 1; },
  });
  const llm = new SequenceLlm([
    {
      content: "Bitcoin is about $70,123 USD. Source: CoinMarketCap. Checked at 2026-06-19T10:00:00Z.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_btc",
    runContext: {
      runId: "run_current_fact_btc",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /\$70,123/);
  assert.equal(searchCalls, 1);
  assert.equal(readCalls, 1);
  assert.equal(screenshotCalls, 0);
  assert.equal(llm.calls, 1);
  assert.ok(events.some((event) => event.type === "current-fact-fast-path-selected"));
  assert.ok(events.some((event) => event.type === "proof-skipped"));
  assert.ok(events.some((event) => event.type === "current-fact-synthesis-completed"));
  assert.equal(events.some((event) => event.title === "LLM step 1"), false);
});

test("BaseAgent captures focused screenshot proof when narrow current fact explicitly asks for it", async () => {
  const registry = new ToolRegistry();
  let screenshotCalls = 0;
  registerCurrentFactTools(registry, {
    onScreenshot: () => { screenshotCalls += 1; },
    screenshotBase64: richPngBase64(),
  });
  const llm = new SequenceLlm([
    {
      content: "Bitcoin is about $70,123 USD. Source: CoinMarketCap. Screenshot proof attached.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ и скриншот-пруф.", {
    runId: "run_current_fact_screenshot",
    runContext: {
      runId: "run_current_fact_screenshot",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    onEvent: (event) => { events.push(event); },
    saveArtifact: saveArtifacts("run_current_fact_screenshot", artifacts),
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Screenshot proof attached|скриншот/iu);
  assert.equal(screenshotCalls, 1);
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename === "coinmarketcap-com.png"));
  assert.equal((result.artifacts ?? []).some((artifact) => artifact.quality?.status === "failed"), false);
  assert.ok(events.some((event) => event.type === "artifact-created"));
});

test("BaseAgent skips stale social sources for current fact source reads", async () => {
  const registry = new ToolRegistry();
  const readUrls: string[] = [];
  const artifacts: AgentArtifact[] = [];
  registerCurrentFactTools(registry, {
    onRead: (input) => { readUrls.push(String(input.url)); },
    searchData: [
      {
        title: "China has launched its plan to shut down Bitcoin exchanges, according ...",
        url: "https://www.facebook.com/mybroadband/posts/china-has-launched-its-plan-to-shut-down-bitcoin-exchanges-according-to-a-report/1508404995881888/",
        content: "20 Sept 2017 · Markets reached a high in 2017. Сейчас цена находится на уровне 3343.",
      },
      {
        title: "Bitcoin (BTC) Price Today | Live Chart | Bybit",
        url: "https://www.bybit.com/en/price/bitcoin/",
        content: "",
      },
      {
        title: "Bitcoin Price Today | BTC to USD Live Price, Market Cap & Chart - Binance",
        url: "https://www.binance.com/en/price/bitcoin",
        content: "The live price of Bitcoin is $70,123 per BTC / USD and updates in real-time.",
      },
    ],
  });
  const llm = new SequenceLlm([
    {
      content: "Bitcoin is about $70,123 USD. Source: Binance.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_stale_social",
    runContext: {
      runId: "run_current_fact_stale_social",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    saveArtifact: saveArtifacts("run_current_fact_stale_social", artifacts),
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(readUrls[0], "https://www.binance.com/en/price/bitcoin");
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename.startsWith("www-binance-com")));
  assert.equal((result.artifacts ?? []).some((artifact) => artifact.filename.startsWith("www-facebook-com")), false);
});

test("BaseAgent prefers current fact sources with explicit numeric currency evidence", async () => {
  const registry = new ToolRegistry();
  const readUrls: string[] = [];
  registerCurrentFactTools(registry, {
    onRead: (input) => { readUrls.push(String(input.url)); },
    searchData: [
      {
        title: "Курс Биткоина онлайн, график и архив цен",
        url: "https://investfunds.example/indexes/9021/",
        content: "BTC/USD (Биткоин) - актуальный курс, график, динамика и архив значений",
      },
      {
        title: "Курс Bitcoin сегодня | цена BTC/USD и данные рынка",
        url: "https://exchange.example/price/bitcoin",
        content: "Цена 1 Bitcoin сейчас составляет $70,123 USD и обновляется в реальном времени.",
      },
    ],
  });
  const llm = new SequenceLlm([{ content: "Bitcoin is about $70,123 USD. Source: exchange.example.", finishReason: "stop", toolCalls: [] }]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_numeric_source",
    runContext: {
      runId: "run_current_fact_numeric_source",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(readUrls[0], "https://exchange.example/price/bitcoin");
});

test("BaseAgent tries the next ranked current fact source when page read fails", async () => {
  const registry = new ToolRegistry();
  const readUrls: string[] = [];
  const artifacts: AgentArtifact[] = [];
  registerCurrentFactTools(registry, {
    onRead: (input) => { readUrls.push(String(input.url)); },
    failReadForUrls: new Set(["https://www.binance.com/en/price/bitcoin"]),
    searchData: [
      {
        title: "Bitcoin Price Today | BTC to USD Live Price, Market Cap & Chart - Binance",
        url: "https://www.binance.com/en/price/bitcoin",
        content: "The live price of Bitcoin is $70,123 per BTC / USD and updates in real-time.",
      },
      {
        title: "BTC USD — Bitcoin Price and Live Chart — TradingView",
        url: "https://www.tradingview.com/symbols/BTCUSD/",
        content: "Bitcoin is trading at $70,120 today with a live chart.",
      },
    ],
  });
  const llm = new SequenceLlm([
    {
      content: "Bitcoin is about $70,120 USD. Source: TradingView.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_read_fallback",
    runContext: {
      runId: "run_current_fact_read_fallback",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    saveArtifact: saveArtifacts("run_current_fact_read_fallback", artifacts),
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(readUrls, ["https://www.binance.com/en/price/bitcoin", "https://www.tradingview.com/symbols/BTCUSD/"]);
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename.startsWith("www-tradingview-com")));
  assert.equal((result.artifacts ?? []).some((artifact) => artifact.filename.startsWith("www-binance-com")), false);
});

test("BaseAgent stops fallback reads when a blocked page has sufficient search evidence", async () => {
  const registry = new ToolRegistry();
  const readUrls: string[] = [];
  registerCurrentFactTools(registry, {
    onRead: (input) => { readUrls.push(String(input.url)); },
    blockerReadForUrls: new Set(["https://www.binance.com/en/price/bitcoin"]),
    searchData: [
      {
        title: "Bitcoin Price Today | BTC to USD Live Price, Market Cap & Chart - Binance",
        url: "https://www.binance.com/en/price/bitcoin",
        content: "The live price of Bitcoin is $70,123 USD today and updates in real-time.",
      },
      {
        title: "BTC USD — Bitcoin Price and Live Chart — TradingView",
        url: "https://www.tradingview.com/symbols/BTCUSD/",
        content: "Bitcoin is trading at $70,120 today with a live chart.",
      },
    ],
  });
  const llm = new SequenceLlm([{ content: "Bitcoin is about $70,123 USD. Source: Binance search evidence.", finishReason: "stop", toolCalls: [] }]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_search_snippet_fallback",
    runContext: {
      runId: "run_current_fact_search_snippet_fallback",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(readUrls, ["https://www.binance.com/en/price/bitcoin"]);
});

test("BaseAgent limits current fact synthesis search evidence to the selected primary source", async () => {
  const registry = new ToolRegistry();
  registerCurrentFactTools(registry, {
    blockerReadForUrls: new Set(["https://www.binance.com/ru/price/bitcoin"]),
    searchData: [
      {
        title: "Курс Bitcoin сегодня | цена BTC/USD и данные рынка",
        url: "https://www.binance.com/ru/price/bitcoin",
        content: "Цена 1 Bitcoin сейчас составляет $70,123 USD и обновляется в реальном времени.",
      },
      {
        title: "Bitcoin price in RUB",
        url: "https://coinmarketcap.com/ru/currencies/bitcoin/",
        content: "Цена Bitcoin сегодня составляет ₽5,000,000 RUB.",
      },
    ],
  });
  const llm = new SequenceLlm([{ content: "Bitcoin is about $70,123 USD. Source: Binance.", finishReason: "stop", toolCalls: [] }]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ.", {
    runId: "run_current_fact_primary_prompt",
    runContext: {
      runId: "run_current_fact_primary_prompt",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
  });

  assert.equal(result.runStatus, "completed");
  const synthesisPrompt = llm.messagesByCall.at(-1)?.find((message) => message.role === "user")?.content ?? "";
  assert.match(synthesisPrompt, /binance\.com\/ru\/price\/bitcoin/);
  assert.doesNotMatch(synthesisPrompt, /coinmarketcap|RUB|₽5,000,000/iu);
});

test("BaseAgent keeps screenshot proof visible after the same URL read was rejected", async () => {
  const registry = new ToolRegistry();
  registerCurrentFactTools(registry, {
    blockerReadForUrls: new Set(["https://www.binance.com/ru/price/bitcoin"]),
    searchData: [
      {
        title: "Курс Bitcoin сегодня | цена BTC/USD и данные рынка",
        url: "https://www.binance.com/ru/price/bitcoin",
        content: "Цена 1 Bitcoin сейчас составляет $70,123 USD и обновляется в реальном времени.",
      },
    ],
  });
  const llm = new SequenceLlm([{ content: "Bitcoin is about $70,123 USD. Screenshot proof attached.", finishReason: "stop", toolCalls: [] }]);
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ и скриншот-пруф.", {
    runId: "run_current_fact_rejected_read_screenshot",
    runContext: {
      runId: "run_current_fact_rejected_read_screenshot",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    saveArtifact: saveArtifacts("run_current_fact_rejected_read_screenshot", artifacts),
  });

  assert.equal(result.runStatus, "completed");
  const synthesisPrompt = llm.messagesByCall.at(-1)?.find((message) => message.role === "user")?.content ?? "";
  assert.match(synthesisPrompt, /browser\.screenshot|Screenshot captured|coinmarketcap-com\.png/iu);
});

test("BaseAgent degrades gracefully when requested screenshot proof fails QA", async () => {
  const registry = new ToolRegistry();
  registerCurrentFactTools(registry, { screenshotBase64: Buffer.from("not a png").toString("base64") });
  const llm = new SequenceLlm([
    {
      content: "Bitcoin is about $70,123 USD. Source: CoinMarketCap. Visual proof failed, text/source evidence was used.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Какая сейчас цена биткоина? Дай краткий ответ и скриншот-пруф.", {
    runId: "run_current_fact_degraded",
    runContext: {
      runId: "run_current_fact_degraded",
      instanceId: "instance-local",
      currentDateTimeIso: "2026-06-19T10:00:00.000Z",
      timeZone: "Europe/Madrid",
    },
    onEvent: (event) => { events.push(event); },
    saveArtifact: saveArtifacts("run_current_fact_degraded", artifacts),
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Visual proof failed|source evidence/);
  assert.ok(events.some((event) => event.type === "proof-degraded"));
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename === "coinmarketcap-com.png" && artifact.quality?.status === "failed"));
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename.endsWith("-source-evidence.json") && artifact.mimeType === "application/json"));
});

test("BaseAgent does not use current fact fast path for broad recommendation research", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  registerCurrentFactTools(registry, { onSearch: () => { searchCalls += 1; } });
  const llm = new SequenceLlm([
    {
      content: "Это исследовательская задача, нужен широкий ресерч.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  await agent.run("Найди лучший ноутбук для программирования и игр до 2500 долларов.", {
    runId: "run_broad_research_no_fast_path",
    runContext: { runId: "run_broad_research_no_fast_path", instanceId: "instance-local" },
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(searchCalls, 0);
  assert.equal(events.some((event) => event.type === "current-fact-fast-path-selected"), false);
});

function registerCurrentFactTools(
  registry: ToolRegistry,
  options: {
    onSearch?: () => void;
    onRead?: (input: Record<string, unknown>) => void;
    onScreenshot?: () => void;
    screenshotBase64?: string;
    searchData?: Array<Record<string, unknown>>;
    failReadForUrls?: Set<string>;
    blockerReadForUrls?: Set<string>;
  } = {},
): void {
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Searches the web for current pages.",
    capabilities: ["web-search", "current-data"],
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    async run() {
      options.onSearch?.();
      return {
        ok: true,
        content: "Bitcoin price today | CoinMarketCap | The live Bitcoin price today is $70,123 USD.",
        data: options.searchData ?? [
          {
            title: "Bitcoin price today",
            url: "https://coinmarketcap.com/currencies/bitcoin/",
            content: "The live Bitcoin price today is $70,123 USD.",
          },
        ],
      };
    },
  });
  registry.register({
    name: "web.read",
    version: "0.1.0",
    description: "Reads a web page.",
    capabilities: ["web-read", "source-extraction"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      options.onRead?.(input);
      if (options.failReadForUrls?.has(String(input.url))) {
        return { ok: false, content: "read failed for test source" };
      }
      if (options.blockerReadForUrls?.has(String(input.url))) {
        return {
          ok: true,
          content: "JavaScript is disabled. In order to continue, we need to verify that you're not a robot.",
          data: { url: input.url, finalUrl: input.url, title: "" },
        };
      }
      return {
        ok: true,
        content: "CoinMarketCap Bitcoin price today. The live Bitcoin price today is $70,123 USD.",
        data: {
          url: input.url,
          finalUrl: typeof input.url === "string" ? input.url : "https://coinmarketcap.com/currencies/bitcoin/",
          title: "Bitcoin price today",
          extractedText: "The live Bitcoin price today is $70,123 USD.",
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    version: "0.1.5",
    description: "Captures focused browser screenshots.",
    capabilities: ["browser-screenshot", "proof-screenshot", "artifact-generation"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      options.onScreenshot?.();
      return {
        ok: true,
        content: `Screenshot captured: ${input.url}`,
        data: {
          finalUrl: input.url,
          title: "Bitcoin price today",
          visibleText: "Bitcoin BTC price $70,123 USD",
          artifact: {
            filename: "coinmarketcap-com.png",
            mimeType: "image/png",
            contentBase64: options.screenshotBase64 ?? richPngBase64(),
            description: `Viewport screenshot captured from ${input.url}`,
          },
        },
      };
    },
  });
}

function saveArtifacts(runId: string, artifacts: AgentArtifact[]) {
  return async (artifact: ArtifactCreateInput): Promise<AgentArtifact> => {
    const contentSize = Buffer.isBuffer(artifact.content) ? artifact.content.length : String(artifact.content).length;
    const saved: AgentArtifact = {
      id: `artifact_${artifacts.length + 1}`,
      runId,
      kind: "output",
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: contentSize,
      url: `/api/runs/${runId}/artifacts/artifact_${artifacts.length + 1}`,
      description: artifact.description,
      quality: artifact.quality,
      createdAt: new Date().toISOString(),
    };
    artifacts.push(saved);
    return saved;
  };
}

function richPngBase64(): string {
  const png = new PNG({ width: 220, height: 140 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      const stripe = Math.floor(x / 12) % 2 === 0;
      png.data[index] = stripe ? 30 : 240;
      png.data[index + 1] = y % 5 === 0 ? 180 : 80;
      png.data[index + 2] = stripe ? 220 : 40;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}
