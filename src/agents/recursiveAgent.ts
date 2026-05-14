/**
 * Phase 28 — Recursive agent loop.
 *
 * The old `UniversalAgent` walks a hard-coded 6-stage pipeline
 * (classify → strategy → plan → workers → reviews → synthesis) for
 * every request, no matter how simple. The price of asking "what's
 * the current bitcoin price?" was ~13 LLM calls and 5 minutes.
 *
 * This agent instead runs a single ReAct-style loop with native
 * function calling:
 *
 *   1. Build a system prompt that lists the agent's capabilities
 *      (every registered tool) and three meta-tools: `spawn_subagent`
 *      (delegate a sub-task to a recursive copy of itself),
 *      `finish` (return the final answer), and `note` (think out
 *      loud to itself between steps).
 *   2. Send the user task. LLM picks a tool. We invoke it.
 *      Append the result to messages. Loop.
 *   3. When the LLM emits `finish`, we return its answer + any
 *      artifacts collected on the way.
 *
 * Simple task = a couple of direct tool calls → finish. ~2–3 LLM
 * calls, no plans, no reviews, no synthesis pass.
 *
 * Complex task = LLM calls `spawn_subagent` for each independent
 * step; each subagent runs the SAME loop on its narrower slice.
 * Depth + iteration limits keep it from running away.
 */

import type {
  AgentArtifact,
  AgentRunResult,
  ArtifactCreateInput,
  Message,
  ModelTier,
} from "../types.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../llm/client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { SkillMemory } from "../memory/skillMemory.js";

const DEFAULT_MAX_ITERATIONS = 12;
// Phase 28 follow-up — keep DEPTH at 1 by default. Otherwise local
// models (Qwen, Gemma) read the spawn_subagent description and
// happily delegate every task to a child copy of themselves
// instead of just calling the real tool. The bitcoin probe with
// MAX_DEPTH=3 produced 4 levels of "let me spawn a subagent to do
// the screenshot" with zero actual screenshot.url invocations.
// With MAX_DEPTH=1 a non-trivial task can still fan out one layer
// of subagents, but the leaves are forced to do real work.
const DEFAULT_MAX_DEPTH = 1;
const RESULT_PREVIEW_CHARS = 6_000;

export type RecursiveAgentEvent =
  | { type: "iteration"; depth: number; iteration: number }
  | { type: "tool-call"; depth: number; tool: string; input: Record<string, unknown>; ok: boolean; durationMs: number; contentPreview: string }
  | { type: "subagent-spawned"; depth: number; childTask: string }
  | { type: "subagent-finished"; depth: number; childTask: string; finalAnswer: string; artifactCount: number }
  | { type: "finish"; depth: number; finalAnswer: string }
  | { type: "iteration-cap"; depth: number };

export type RecursiveAgentRunOptions = {
  saveArtifact?: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  signal?: AbortSignal;
  onEvent?: (event: RecursiveAgentEvent) => Promise<void> | void;
  maxIterations?: number;
  maxDepth?: number;
  modelTier?: ModelTier;
};

export class RecursiveAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly memory: SkillMemory,
    private readonly tools: ToolRegistry,
  ) {}

  /**
   * Public entry point. Mirrors `UniversalAgent.run` so the existing
   * `RunsService.execute()` call site can switch implementations via
   * an `agentMode` flag without touching the runs API contract.
   */
  async run(task: string, options: RecursiveAgentRunOptions = {}): Promise<AgentRunResult> {
    const collectedArtifacts: AgentArtifact[] = [];
    const result = await this.loop(task, {
      ...options,
      depth: 0,
      collectedArtifacts,
    });

    return {
      finalAnswer: result.finalAnswer,
      complexity: {
        mode: "direct",
        reason: "recursive agent — complexity decided per iteration by the model itself",
        domains: [],
        riskLevel: "low",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: collectedArtifacts,
    };
  }

  private async loop(
    task: string,
    ctx: {
      depth: number;
      maxIterations?: number;
      maxDepth?: number;
      saveArtifact?: (a: ArtifactCreateInput) => Promise<AgentArtifact>;
      signal?: AbortSignal;
      onEvent?: (e: RecursiveAgentEvent) => Promise<void> | void;
      modelTier?: ModelTier;
      collectedArtifacts: AgentArtifact[];
    },
  ): Promise<{ finalAnswer: string }> {
    const maxIterations = ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_DEPTH;

    const toolSchemas = this.buildToolSchemas(ctx.depth < maxDepth);
    const messages: Message[] = [
      { role: "system", content: this.buildSystemPrompt(toolSchemas, ctx.depth, maxDepth) },
      { role: "user", content: task },
    ];

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      ctx.onEvent?.({ type: "iteration", depth: ctx.depth, iteration });
      if (ctx.signal?.aborted) {
        return { finalAnswer: "[run cancelled]" };
      }
      let reply: LlmToolReply;
      try {
        reply = await this.llm.completeWithTools(messages, toolSchemas, {
          modelTier: ctx.modelTier ?? "L",
          signal: ctx.signal,
          // Phase 28 follow-up — force a tool call on iteration 1.
          // Local models otherwise generate a "I can't help, the tool
          // is broken (puppeteer-core missing)" hallucination on
          // simple-fact tasks like "what's the price of X?", refusing
          // to even try the tool because they pattern-matched the
          // tool name against a training-memory failure. Required
          // tool_choice on the first turn pins them to actually
          // invoke something — usually the right tool, occasionally
          // `finish` if the task truly needs no action.
          toolChoice: iteration === 1 ? "required" : "auto",
          maxTokens: 1_500,
        });
      } catch (error) {
        // Surface the error as a tool-style message so the loop can
        // either give up or push the user toward retrying. We bail
        // here rather than catching forever — a broken LLM means the
        // run is broken.
        throw new Error(`Recursive agent: LLM failed at depth=${ctx.depth} iter=${iteration}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // No tool calls + has content. Two cases:
      //
      //   1. Final iteration / model clearly intends to wrap up
      //      (content looks like an answer to the user) — accept
      //      as implicit finish.
      //   2. Model produced a "let me check..." or "I will now
      //      look up..." style preamble and forgot to issue the
      //      tool_call — push back a system-style reminder and
      //      let it try again. Otherwise local models like Qwen
      //      and Gemma waste a quarter of their iteration budget
      //      narrating intent without acting.
      if (reply.finishReason !== "tool_calls" && reply.toolCalls.length === 0) {
        const content = reply.content || "";
        const looksLikePreamble = /(?:^|\b)(?:let me|i will|i'll|i need to|i'm going to|сейчас|я попробую|я проверю|i should)\b/i.test(content) && content.length < 400;
        const isLastIteration = iteration >= maxIterations;
        if (looksLikePreamble && !isLastIteration) {
          messages.push({ role: "assistant", content } as Message);
          messages.push({
            role: "user",
            content:
              "Don't narrate. Call a tool now, or call `finish` with the final answer. Pure prose is not an action.",
          } as Message);
          continue;
        }
        const answer = content || "(empty)";
        ctx.onEvent?.({ type: "finish", depth: ctx.depth, finalAnswer: answer });
        return { finalAnswer: answer };
      }

      // Append the assistant turn so the next iteration sees the
      // same conversation the model just produced. We capture
      // tool_calls explicitly because that's how OpenAI-shape
      // chat-completion echoes them back.
      messages.push({
        role: "assistant",
        content: reply.content || "",
        // Forwarded via JSON-stringify to match the format
        // LM Studio expects when we cite tool_call_id later.
        // The runtime LlmClient just passes our Message[]
        // through, so embedding tool_calls here is safe.
        tool_calls: reply.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      } as Message);

      // Phase 28 debug — log every tool call attempt so we can see
      // why the bitcoin task hallucinates errors instead of invoking
      // screenshot_url. Cheap; runs once per iteration.
      console.log(
        `[recursive depth=${ctx.depth} iter=${iteration}] finish_reason=${reply.finishReason} ` +
          `tool_calls=[${reply.toolCalls.map((c) => c.name).join(", ")}] ` +
          `content_first40=${(reply.content || "").slice(0, 40).replace(/\n/g, " ")}`,
      );
      for (const call of reply.toolCalls) {
        if (ctx.signal?.aborted) return { finalAnswer: "[run cancelled]" };
        if (call.name === "finish") {
          const answer = typeof call.arguments.answer === "string"
            ? call.arguments.answer
            : reply.content || "(empty)";
          ctx.onEvent?.({ type: "finish", depth: ctx.depth, finalAnswer: answer });
          return { finalAnswer: answer };
        }
        if (call.name === "spawn_subagent" && ctx.depth < maxDepth) {
          const subtask = String(call.arguments.task ?? "");
          if (!subtask.trim()) {
            messages.push(this.toolResultMessage(call.id, false, "spawn_subagent requires a non-empty task"));
            continue;
          }
          ctx.onEvent?.({ type: "subagent-spawned", depth: ctx.depth, childTask: subtask });
          let subResult: { finalAnswer: string };
          try {
            subResult = await this.loop(subtask, {
              ...ctx,
              depth: ctx.depth + 1,
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            messages.push(this.toolResultMessage(call.id, false, `subagent failed: ${msg}`));
            continue;
          }
          ctx.onEvent?.({
            type: "subagent-finished",
            depth: ctx.depth,
            childTask: subtask,
            finalAnswer: subResult.finalAnswer,
            artifactCount: ctx.collectedArtifacts.length,
          });
          messages.push(this.toolResultMessage(call.id, true, subResult.finalAnswer));
          continue;
        }
        if (call.name === "note") {
          // Pure scratchpad call — append as tool result but no
          // side effects. Lets the model think between actions.
          const note = String(call.arguments.thought ?? "").slice(0, 600);
          messages.push(this.toolResultMessage(call.id, true, `note recorded: ${note}`));
          continue;
        }
        // Regular registered tool. Match by sanitized name because
        // the LLM saw and replied with the sanitized form (dots
        // stripped to underscores).
        const tool =
          this.tools.get(call.name) ??
          this.tools.list().find((t) => t.name.replace(/[^a-zA-Z0-9_-]/g, "_") === call.name);
        if (!tool) {
          messages.push(
            this.toolResultMessage(
              call.id,
              false,
              `Tool "${call.name}" is not registered. Available tools: ${this.tools.list().map((t) => t.name).join(", ")}.`,
            ),
          );
          continue;
        }
        const t0 = Date.now();
        let toolResult: ToolResult;
        try {
          toolResult = await this.tools.execute(tool, call.arguments, {
            signal: ctx.signal,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // Phase 28 follow-up — emit a structured event for the
          // throw so the operator sees the failure in the run
          // timeline. Without this the model writes "the tool
          // failed with X" but the trace has no record of it.
          ctx.onEvent?.({
            type: "tool-call",
            depth: ctx.depth,
            tool: call.name,
            input: call.arguments,
            ok: false,
            durationMs: Date.now() - t0,
            contentPreview: `Tool threw: ${msg}`,
          });
          console.log(`[recursive depth=${ctx.depth} iter=${iteration}] tool ${call.name} threw: ${msg}`);
          messages.push(this.toolResultMessage(call.id, false, `Tool ${call.name} threw: ${msg}`));
          continue;
        }
        const durationMs = Date.now() - t0;

        // If the tool returned an artifact-shaped payload AND a
        // saver is wired, persist it so the caller (RunsService)
        // can attach it to the run record. We support both shapes
        // the existing fleet uses: `data.artifact: {filename,
        // mimeType, contentBase64}` and the flat
        // `data: {imageBase64}` form council tools emit.
        if (ctx.saveArtifact && toolResult.ok) {
          const saved = await this.maybeSaveArtifact(call.name, call.arguments, toolResult, ctx.saveArtifact);
          if (saved) ctx.collectedArtifacts.push(saved);
        }

        const previewSource =
          (toolResult.content ? `${toolResult.content}\n\n` : "") +
          renderToolDataForModel(toolResult.data);
        const preview = previewSource.slice(0, RESULT_PREVIEW_CHARS);
        ctx.onEvent?.({
          type: "tool-call",
          depth: ctx.depth,
          tool: call.name,
          input: call.arguments,
          ok: toolResult.ok,
          durationMs,
          contentPreview: preview.slice(0, 400),
        });
        messages.push(this.toolResultMessage(call.id, toolResult.ok, preview));
      }
    }

    ctx.onEvent?.({ type: "iteration-cap", depth: ctx.depth });
    return {
      finalAnswer:
        "Recursive agent hit its iteration cap without calling `finish`. The last assistant message did not include a final answer.",
    };
  }

  /**
   * Build the tool schema list the LLM sees as function-calling
   * tools. Includes every registered Tool + the meta-tools
   * (spawn_subagent at non-leaf depth, finish always, note always).
   */
  private buildToolSchemas(includeSpawn: boolean): LlmToolSchema[] {
    const out: LlmToolSchema[] = [];
    for (const tool of this.tools.list()) {
      const params =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {}, additionalProperties: true };
      // Phase 28 follow-up — LM Studio + Qwen + Gemma normalize tool
      // names by stripping non-alphanumerics: `screenshot.url` arrives
      // back as `screenshot_url` in the model's tool_calls reply.
      // We pre-sanitize the schema name so what we send equals what
      // we receive, and dispatch maps it back to the registry's
      // canonical name (which may contain dots like "screenshot.url"
      // or "web.duckduckgo.search").
      const safeName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      out.push({
        type: "function",
        function: {
          name: safeName,
          description: limitText(tool.description ?? `Tool ${tool.name}.`, 600),
          parameters: params,
        },
      });
    }
    if (includeSpawn) {
      out.push({
        type: "function",
        function: {
          name: "spawn_subagent",
          description:
            "Delegate a self-contained sub-task to a child recursive agent. The child has the SAME tools and runs the SAME loop; use it when a step needs its own multi-tool plan. Returns the child's final answer. Prefer direct tool calls when the step is atomic.",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "The sub-task description. Should be concrete and self-contained — the child won't see the parent conversation, only this string.",
              },
              expectedOutput: {
                type: "string",
                description: "Optional one-sentence description of what the child should return.",
              },
            },
            required: ["task"],
          },
        },
      });
    }
    out.push({
      type: "function",
      function: {
        name: "finish",
        description:
          "Return the FINAL answer to the user. Call this exactly once at the end. The `answer` field is what the user will see.",
        parameters: {
          type: "object",
          properties: {
            answer: { type: "string", description: "The final answer text. Include any captured artifact URLs that should appear in the response." },
          },
          required: ["answer"],
        },
      },
    });
    out.push({
      type: "function",
      function: {
        name: "note",
        description:
          "Record a short internal thought without taking any action. Useful for explaining your plan between tool calls. Does NOT show up in the user-visible answer.",
        parameters: {
          type: "object",
          properties: {
            thought: { type: "string" },
          },
          required: ["thought"],
        },
      },
    });
    return out;
  }

  private buildSystemPrompt(tools: LlmToolSchema[], depth: number, maxDepth: number): string {
    const toolList = tools
      .map((t) => `  - ${t.function.name}: ${t.function.description}`)
      .join("\n");
    return [
      "You are a tool-using agent. Solve the user's task by calling tools, then call `finish` with the answer.",
      "",
      "Hard rules:",
      "  • DO call a real tool first (e.g. screenshot_url, web_duckduckgo_search). Do NOT explain what you're going to do — just call the tool.",
      "  • DO NOT hallucinate errors about tools. If a tool returns a result, trust it. Quote its data verbatim in your `finish` answer.",
      "  • DO NOT invent specific numbers, dates, prices, URLs from your training memory. Only quote what a tool returned this turn.",
      "  • spawn_subagent exists for genuinely multi-step tasks. For a single fact lookup (\"what is the current price of X\"), call the real tool directly.",
      "",
      "Available tools:",
      toolList,
      "",
      `(depth ${depth}/${maxDepth}${depth >= maxDepth ? " — spawn_subagent disabled" : ""})`,
    ].join("\n");
  }

  /**
   * Build a `role: "tool"` message that the OpenAI-style chat API
   * (and LM Studio's compatible endpoint) recognizes as the result
   * of the previous tool_call.
   */
  private toolResultMessage(toolCallId: string, ok: boolean, content: string): Message {
    return {
      role: "tool",
      content: ok ? content : `Error: ${content}`,
      tool_call_id: toolCallId,
    } as Message;
  }

  /**
   * Inspect a ToolResult for an artifact payload and persist it via
   * the run's `saveArtifact` hook. Mirrors the dual-shape support in
   * `universalAgent.ts:isScreenshotToolData` so council-built tools
   * that return `data.imageBase64` work alongside the canonical
   * `data.artifact.contentBase64` shape.
   */
  private async maybeSaveArtifact(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    saveArtifact: (a: ArtifactCreateInput) => Promise<AgentArtifact>,
  ): Promise<AgentArtifact | undefined> {
    const data = result.data;
    if (!data || typeof data !== "object") return undefined;
    const dAny = data as {
      artifact?: { filename?: string; mimeType?: string; contentBase64?: string; description?: string };
      imageBase64?: string;
      image?: string;
      contentBase64?: string;
    };
    let artifactInput: ArtifactCreateInput | undefined;
    if (dAny.artifact?.contentBase64) {
      artifactInput = {
        filename: dAny.artifact.filename ?? `${toolName}.bin`,
        mimeType: dAny.artifact.mimeType ?? "application/octet-stream",
        content: Buffer.from(dAny.artifact.contentBase64, "base64"),
        description: dAny.artifact.description,
      };
    } else if (dAny.imageBase64 ?? dAny.image ?? dAny.contentBase64) {
      const base64 = dAny.imageBase64 ?? dAny.image ?? dAny.contentBase64 ?? "";
      const url = typeof input.url === "string" ? input.url : undefined;
      const slug = url ? slugFromUrl(url) : toolName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      artifactInput = {
        filename: `${slug}.png`,
        mimeType: "image/png",
        content: Buffer.from(base64, "base64"),
        description: url ? `Screenshot captured from ${url}` : `Output of ${toolName}`,
      };
    }
    if (!artifactInput) return undefined;
    try {
      return await saveArtifact(artifactInput);
    } catch {
      return undefined;
    }
  }
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const path = u.pathname.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60).replace(/^-+|-+$/g, "");
    return `${host}${path ? `-${path}` : ""}`.slice(0, 90) || "screenshot";
  } catch {
    return "screenshot";
  }
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
}

/**
 * Render `ToolResult.data` for the model in a way that preserves
 * useful fields without ballooning the context. Mirrors the budgeted
 * `formatToolDataForEvidenceRecord` in universalAgent.ts but inline
 * to keep the recursive-agent module standalone.
 */
function renderToolDataForModel(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.slice(0, 2_000);
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) {
    return JSON.stringify(data.slice(0, 12)).slice(0, 2_000);
  }
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    const entries: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && value.length > 1500 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
        entries.push(`${key}: <${value.length}-byte base64 omitted>`);
        continue;
      }
      const rendered = typeof value === "string"
        ? JSON.stringify(value.length > 800 ? `${value.slice(0, 800)}...` : value)
        : JSON.stringify(value).slice(0, 800);
      entries.push(`${key}: ${rendered}`);
    }
    return entries.join("\n");
  }
  return "";
}
