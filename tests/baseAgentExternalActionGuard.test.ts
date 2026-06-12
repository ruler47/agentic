import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

class SequenceLlm {
  calls = 0;

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(
    _messages: Message[],
    _tools: LlmToolSchema[],
  ): Promise<LlmToolReply> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("BaseAgent blocks direct browser operation for approval-mode external actions", async () => {
  let browserToolExecuted = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser automation for navigation, clicks, and form filling.",
    capabilities: ["browser-operate", "browser-automation", "form-fill"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      browserToolExecuted = true;
      return { ok: true, content: "browser operated" };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_browser",
          name: "browser_operate",
          arguments: { url: "https://booking.example", commands: [{ action: "click", text: "Book" }] },
        },
      ],
    },
    {
      content: "Подготовлена запись в **Umeo Marbella**. Нужны подтверждение времени и контакт перед отправкой формы.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Запиши меня на стрижку в Umeo Marbella завтра после 17:00", {
    runId: "run_external_action_browser_guard",
    maxSteps: 3,
    runContext: { runId: "run_external_action_browser_guard", threadId: "thread_external_action_browser_guard" },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(browserToolExecuted, false);
  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.actionType, "appointment");
  assert.equal(result.actionProposals?.[0]?.target, "Umeo Marbella");
  assert.ok(events.some((event) =>
    event.type === "tool-completed" &&
    /approval mode blocks direct browser operation/i.test(event.detail ?? ""),
  ));
});

test("BaseAgent blocks browser preparation for bookable lookup once user details imply approval preparation", async () => {
  let browserToolExecuted = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser automation for navigation, clicks, and form filling.",
    capabilities: ["browser-operate", "browser-automation", "form-fill"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      browserToolExecuted = true;
      return { ok: true, content: "browser operated" };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_browser",
          name: "browser_operate",
          arguments: { url: "https://booksy.example/barber", commands: [{ action: "click", text: "Book" }] },
        },
      ],
    },
    {
      content: "Подготовлена запись в **Memento Barbershop**. Данные: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com. Услуга: мужская стрижка. Время: следующая неделя после 17:00.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run([
    "Найди в Марбелье барбершоп, где можно записаться онлайн.",
    "Данные для записи: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Дата: на следующей неделе после 17:00.",
    "Услуга: обычная мужская стрижка.",
    "Режим: approval. Перед отправкой дай скриншот заполненной формы.",
  ].join("\n"), {
    runId: "run_external_action_bookable_lookup_guard",
    maxSteps: 3,
    runContext: { runId: "run_external_action_bookable_lookup_guard", threadId: "thread_external_action_bookable_lookup_guard" },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(browserToolExecuted, false);
  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.actionType, "appointment");
  assert.equal(result.actionProposals?.[0]?.target, "Memento Barbershop");
  assert.ok(events.some((event) =>
    event.type === "tool-completed" &&
    /approval mode blocks direct browser operation/i.test(event.detail ?? ""),
  ));
});

test("BaseAgent creates approval proposal when user says not to submit without confirmation", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Searches the web.",
    capabilities: ["web_search"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        ok: true,
        content: "Memento Barbershop https://booksy.example/memento Book online.",
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_search",
          name: "web_search",
          arguments: { query: "Memento Barbershop Marbella online booking" },
        },
      ],
    },
    {
      content: "Выбран **Memento Barbershop**. Источник: https://booksy.example/memento. Данные: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com. Услуга: стрижка. Время: после 17:00 с понедельника по четверг. Не отправлять без подтверждения.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run([
    "Найди мне барбершоп в Марбелье, где можно записаться онлайн.",
    "Заполни форму записи моими данными, но не отправляй без моего подтверждения.",
    "Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Стрижка, вечером после 17:00 с пн по чт.",
  ].join("\n"), {
    runId: "run_external_action_no_submit_without_confirmation",
    maxSteps: 3,
    runContext: { runId: "run_external_action_no_submit_without_confirmation", threadId: "thread_external_action_no_submit_without_confirmation" },
  });

  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.actionType, "appointment");
  assert.equal(result.actionProposals?.[0]?.target, "Memento Barbershop");
  assert.equal(result.actionProposals?.[0]?.approvalRequired, true);
  assert.equal(result.actionProposals?.[0]?.executionMode, "approval");
  assert.equal(result.actionProposals?.[0]?.userExplicitlyForbidsAction, true);
  assert.equal(result.actionProposals?.[0]?.preparation?.missingInputs.length, 0);
});

test("BaseAgent frames follow-up contact details using thread external-action context", async () => {
  const llm = new SequenceLlm([
    {
      content: "Выбран **Memento Barbershop**. Источник: https://booksy.example/memento. Данные: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com. Услуга: стрижка. Время: после 17:00 с понедельника по четверг. Не отправлять без подтверждения.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run([
    "Dimitrii Bilokon",
    "617789419",
    "dimitriy.belokon@gmail.com",
    "стрижка",
    "вечером после 17.00 с пн по чт",
  ].join("\n"), {
    runId: "run_external_action_thread_followup",
    maxSteps: 1,
    runContext: {
      runId: "run_external_action_thread_followup",
      threadId: "thread_external_action_thread_followup",
      thread: {
        summary: "User asked to find a Marbella barbershop with online booking, fill the booking form with their details, do not submit without confirmation, and show a screenshot before final submit. Memento Barbershop on Booksy was selected.",
        acceptedFacts: [
          "Selected target: Memento Barbershop",
          "Source URL: https://booksy.example/memento",
        ],
      },
    },
  });

  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.actionType, "appointment");
  assert.equal(result.actionProposals?.[0]?.target, "Memento Barbershop");
  assert.equal(result.actionProposals?.[0]?.approvalRequired, true);
  assert.equal(result.actionProposals?.[0]?.preparation?.missingInputs.length, 0);
});

test("BaseAgent treats contact details plus take-the-best follow-up as appointment preparation", async () => {
  const llm = new SequenceLlm([
    {
      content: "Лучший вариант — **Legendary Barber Club Marbella**. Источник: https://booksy.example/legendary. Данные: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com. Услуга: стрижка. Время: после 17:00 с понедельника по четверг.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run(
    "Dimitrii Bilokon 617789419 dimitriy.belokon@gmail.com стрижка вечером после 17.00 с пн по чт\nбери тот что лучше барбершоп",
    {
      runId: "run_external_action_thread_take_best_followup",
      maxSteps: 1,
      runContext: {
        runId: "run_external_action_thread_take_best_followup",
        threadId: "thread_external_action_thread_take_best_followup",
        thread: {
          summary: "Latest request: найди мне барбершоп в Марбелье где можно записаться онлайн. Answered: Memento Barbershop and Legendary Barber Club are available through Booksy online booking.",
          acceptedFacts: [
            "Previous run found bookable barbershops in Marbella.",
          ],
        },
      },
    },
  );

  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.actionType, "appointment");
  assert.equal(result.actionProposals?.[0]?.target, "Legendary Barber Club Marbella");
  assert.equal(result.actionProposals?.[0]?.approvalRequired, true);
  assert.equal(result.actionProposals?.[0]?.preparation?.missingInputs.length, 0);
});

test("BaseAgent does not source-ground user-provided booking details for approval proposals", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Searches the web.",
    capabilities: ["web_search"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        ok: true,
        content: [
          "Memento Barbershop | Barbería en Marbella - Book Online",
          "https://booksy.example/memento",
          "Online appointments are available through Booksy.",
        ].join("\n"),
      };
    },
  });
  registry.register({
    name: "browser.operate",
    version: "0.1.0",
    description: "Browser automation for navigation, clicks, and form filling.",
    capabilities: ["browser-operate", "browser-automation", "form-fill"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "browser operated" };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_search",
          name: "web_search",
          arguments: { query: "Memento Barbershop Marbella online booking" },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_browser",
          name: "browser_operate",
          arguments: { url: "https://booksy.example/memento", commands: [{ action: "click", text: "Book" }] },
        },
      ],
    },
    {
      content: [
        "Выбран **Memento Barbershop**.",
        "Источник: https://booksy.example/memento",
        "Данные из запроса: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
        "Граница: подготовить форму и остановиться до финального подтверждения.",
      ].join("\n"),
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run([
    "Найди в Марбелье барбершоп, где можно записаться онлайн.",
    "Данные для записи: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Дата: на следующей неделе после 17:00.",
    "Услуга: обычная мужская стрижка.",
    "Режим: approval. Перед отправкой дай скриншот заполненной формы.",
  ].join("\n"), {
    runId: "run_external_action_user_details_grounding",
    maxSteps: 4,
    runContext: { runId: "run_external_action_user_details_grounding", threadId: "thread_external_action_user_details_grounding" },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.target, "Memento Barbershop");
  assert.ok(!events.some((event) => event.type === "agent-source-grounding-repair-requested"));
  assert.ok(!events.some((event) => event.type === "agent-proof-repair-requested"));
});
