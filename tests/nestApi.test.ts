import "reflect-metadata";

import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BadRequestException, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, type NextFunction, type Request, type Response } from "express";
import { AppModule } from "../src/server/app.module.js";
import { ApiExceptionFilter } from "../src/server/common/filters/api-exception.filter.js";
import { RUN_STORE, TOOL_REGISTRY } from "../src/server/persistence/tokens.js";
import type { RunStore } from "../src/runs/types.js";
import type { AgentRunResult, ExternalActionProposal } from "../src/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";

type NestFixture = {
  app: INestApplication;
  baseUrl: string;
};

async function createNestFixture(): Promise<NestFixture> {
  process.env.TOOL_BUILD_WORKER = "disabled";
  process.env.LLM_BASE_URL = "http://127.0.0.1:65000/v1";
  process.env.LLM_MODEL = "offline";
  process.env.SWAGGER_DISABLED = "false";
  process.env.DATABASE_URL = "";
  process.env.TOOL_BUILD_MIGRATION_QA_DATABASE_URL = "";
  process.env.BUILTIN_TOOLS = "disabled";

  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
  app.use(json());
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };
    if (
      candidate?.type === "entity.parse.failed" ||
      candidate?.status === 400 ||
      candidate?.statusCode === 400
    ) {
      response
        .status(400)
        .type("application/json")
        .send({ error: `Invalid JSON request body: ${String(candidate.message ?? "parse failed")}` });
      return;
    }
    next(error);
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((error) => Object.values(error.constraints ?? {}));
        return new BadRequestException(messages[0] ?? "Validation failed");
      },
    }),
  );

  const config = new DocumentBuilder()
    .setTitle("Agentic Universal Agent API")
    .setDescription("Base Agent/Tool/LLM runtime for the Agentic platform.")
    .setVersion("0.1.0")
    .addServer("/")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
    yamlDocumentUrl: "api/docs-yaml",
  });

  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { expectedStatus?: number } = {},
): Promise<T> {
  const expectedStatus = options.expectedStatus ?? 200;
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}: ${body}`);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function closeFixture(fixture: NestFixture): Promise<void> {
  await fixture.app.close();
}

test("Nest API serves the base console, tools, docs, and run creation", async () => {
  const fixture = await createNestFixture();
  try {
    const health = await requestJson<{
      ok: boolean;
      persistence: {
        database: { mode: string; status: string; configured: boolean };
        stores: Array<{ name: string; mode: string; durable: boolean }>;
      };
    }>(fixture.baseUrl, "/api/health");
    assert.equal(health.ok, true);
    assert.deepEqual(health.persistence.database, {
      mode: "in-memory",
      status: "unconfigured",
      configured: false,
    });
    assert.equal(health.persistence.stores.find((store) => store.name === "runs")?.durable, false);
    assert.equal(health.persistence.stores.find((store) => store.name === "toolMetadata")?.mode, "local-json");

    const openapi = await requestJson<{ openapi: string; info: { title: string } }>(
      fixture.baseUrl,
      "/api/docs-json",
    );
    assert.match(openapi.openapi, /^3\./);
    assert.equal(openapi.info.title, "Agentic Universal Agent API");

    const index = await fetch(`${fixture.baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Agentic|html/i);

    const tools = await requestJson<{ tools: Array<{ name: string; status?: string }> }>(
      fixture.baseUrl,
      "/api/tools",
    );
    assert.equal(tools.tools.some((tool) => tool.name === "browser.operate"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "file.write"), false);

    const runCreated = await requestJson<{ run: { id: string; status: string } }>(
      fixture.baseUrl,
      "/api/runs",
      {
        method: "POST",
        expectedStatus: 202,
        body: JSON.stringify({
          task: "Скажи одним предложением, что такое универсальный агент",
          channel: "web",
          requesterUserId: "user-admin",
        }),
      },
    );
    assert.match(runCreated.run.id, /^run_/);
    assert.ok(["queued", "running"].includes(runCreated.run.status));
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API no longer exposes legacy tool-build and tool-rework endpoints", async () => {
  const fixture = await createNestFixture();
  try {
    await requestJson(fixture.baseUrl, "/api/tool-build-runs", { expectedStatus: 404 });
    await requestJson(fixture.baseUrl, "/api/tool-build-requests", { expectedStatus: 404 });
    await requestJson(fixture.baseUrl, "/api/tool-investigations", { expectedStatus: 404 });
    await requestJson(fixture.baseUrl, "/api/tool-rework-waits", { expectedStatus: 404 });
    await requestJson(fixture.baseUrl, "/api/tool-migrations", { expectedStatus: 404 });
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API supports external action approval and blocked commit trace", async () => {
  const fixture = await createNestFixture();
  try {
    const runStore = fixture.app.get<RunStore>(RUN_STORE);
    const target = `Test ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`;
    const expectedToolName = "external.action.commit";
    const run = await runStore.create("Забронируй столик", {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
    });
    const proposal: ExternalActionProposal = {
      id: `action_${run.id}_1`,
      runId: run.id,
      actionType: "reservation",
      status: "proposed",
      title: "Reservation proposal: Test",
      summary: "reservation: prepare booking",
      proposedAction: "Prepare to submit a reservation after approval.",
      target,
      approvalRequired: true,
      userExplicitlyForbidsAction: false,
      allowedWithoutApproval: ["prepare draft"],
      prohibitedWithoutApproval: ["submit a reservation"],
      sourceUrls: [],
      artifactIds: [],
      commitExecutor: {
        kind: "manual_operator",
        ready: false,
        risk: "high",
        reason: "fixture executor missing",
        missing: ["generated commit tool"],
        expectedProof: ["provider confirmation"],
      },
      createdAt: new Date().toISOString(),
      createdBy: "base-agent",
    };
    const result: AgentRunResult = {
      finalAnswer: "Prepared reservation proposal.",
      complexity: {
        mode: "direct",
        reason: "fixture",
        domains: [],
        riskLevel: "medium",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: [],
      actionProposals: [proposal],
    };
    await runStore.complete(run.id, result);
    await runStore.appendEvent(run.id, {
      id: "proposal-created",
      spanId: "proposal-created",
      type: "external-action-proposal-created",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "External action proposal created",
      timestamp: new Date().toISOString(),
      payload: { proposalId: proposal.id },
    });

    const listed = await requestJson<{ proposals: Array<{ proposal: { id: string; status: string }; executorBuild?: { status: string; toolName: string } }> }>(
      fixture.baseUrl,
      "/api/action-proposals",
    );
    assert.ok(listed.proposals.some((item) => item.proposal.id === proposal.id && item.proposal.status === "proposed"));
    assert.ok(listed.proposals.some((item) =>
      item.proposal.id === proposal.id &&
      item.executorBuild?.status === "needed" &&
      item.executorBuild.toolName === expectedToolName
    ));

    const approved = await requestJson<{ proposal: { proposal: { status: string } } }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(proposal.id)}/approve`,
      { method: "POST", body: JSON.stringify({ reason: "test approval" }) },
    );
    assert.equal(approved.proposal.proposal.status, "approved");

    const blocked = await requestJson<{ proposal: { proposal: { status: string }; execution?: { status: string; reason?: string } } }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(proposal.id)}/commit`,
      { method: "POST" },
    );
    assert.equal(blocked.proposal.proposal.status, "approved");
    assert.equal(blocked.proposal.execution?.status, "blocked");
    assert.match(
      blocked.proposal.execution?.reason ?? "",
      /fixture executor missing|missing_requirements|generated commit executor/i,
    );

    const updated = await runStore.get(run.id);
    assert.ok(updated?.events.some((event) => event.type === "external-action-proposal-approved"));
    assert.ok(updated?.events.some((event) => event.type === "external-action-commit-blocked"));
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API runs the fixture external-action lifecycle through build, attach, and commit", async () => {
  const workspaceRoot = `.tmp-nest-action-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const fixture = await createNestFixture();
  try {
    const runStore = fixture.app.get<RunStore>(RUN_STORE);
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser preparation tool.",
      capabilities: ["browser-operate", "browser-automation"],
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          prepareOnly: { type: "boolean" },
          commands: { type: "array" },
        },
        required: ["url"],
      },
      async run(input) {
        const commands = Array.isArray(input.commands)
          ? input.commands.filter((item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
            )
          : [];
        return {
          ok: true,
          content: "Prepared local fixture page and captured proof.",
          data: {
            finalUrl: input.url,
            pageTitle: "Restaurant reservation fixture",
            extractedText:
              "Draft is filled. Confirm reservation remains the final commit boundary.",
            links: [],
            actionCandidates: [
              {
                text: "Confirm reservation",
                selector: "#confirm",
              },
            ],
            steps: commands.map((command, index) => ({
              index,
              action: String(command.action),
              ok: true,
              detail: String(command.label ?? command.action),
            })),
            artifacts: [
              {
                filename: "reservation-draft-proof.txt",
                mimeType: "text/plain",
                content: Buffer.from("Prepared reservation draft proof"),
                description: "Fixture proof artifact for prepared reservation draft.",
              },
            ],
          },
        };
      },
    });
    const created = await requestJson<{
      proposal: {
        proposal: { id: string; status: string; commitExecutor?: { ready: boolean } };
        run: { id: string; channel?: string };
        executorBuild?: { status: string; toolName: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({
        actionType: "reservation",
        fixtureBaseUrl: fixture.baseUrl,
      }),
    });
    assert.equal(created.proposal.proposal.status, "proposed");
    assert.equal(created.proposal.run.channel, "fixture");
    assert.equal(created.proposal.executorBuild?.status, "needed");

    const prepared = await requestJson<{
      proposal: {
        preparationExecution?: {
          status: string;
          preparedSession?: { currentUrl?: string; filledFields?: unknown[] };
        };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(created.proposal.proposal.id)}/prepare`,
      { method: "POST" },
    );
    assert.equal(prepared.proposal.preparationExecution?.status, "completed");
    assert.match(
      prepared.proposal.preparationExecution?.preparedSession?.currentUrl ?? "",
      /\/api\/fixtures\/external-actions\/reservation$/,
    );
    assert.equal(prepared.proposal.preparationExecution?.preparedSession?.filledFields?.length, 5);

    await requestJson(fixture.baseUrl, `/api/action-proposals/${encodeURIComponent(created.proposal.proposal.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ reason: "fixture approval" }),
    });

    const built = await requestJson<{
      proposal: {
        proposal: { status: string; commitExecutor?: { ready: boolean; toolName?: string } };
        executorBuild?: { status: string; toolName: string; commitExecutor?: { ready: boolean } };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(created.proposal.proposal.id)}/build-executor`,
      {
        method: "POST",
        body: JSON.stringify({ authoringMode: "scaffold", activateOnSuccess: true }),
      },
    );
    assert.equal(built.proposal.proposal.status, "approved");
    assert.equal(
      built.proposal.executorBuild?.status,
      "attached",
      JSON.stringify(built.proposal.executorBuild, null, 2),
    );
    assert.equal(built.proposal.proposal.commitExecutor?.ready, true);
    assert.equal(built.proposal.proposal.commitExecutor?.toolName, "external.action.commit");

    const committed = await requestJson<{
      proposal: {
        proposal: { status: string };
        execution?: { status: string; toolName?: string; contentPreview?: string; dataPreview?: unknown };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(created.proposal.proposal.id)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({ input: { fixtureConfirmation: "fixture-confirmed-nest" } }),
      },
    );
    assert.equal(
      committed.proposal.proposal.status,
      "committed",
      JSON.stringify(committed.proposal, null, 2),
    );
    assert.equal(
      committed.proposal.execution?.status,
      "committed",
      JSON.stringify(committed.proposal, null, 2),
    );
    assert.match(committed.proposal.execution?.contentPreview ?? "", /fixture_reservation_/);
    const dataPreviewText = JSON.stringify(
      committed.proposal.execution?.dataPreview,
    );
    assert.match(dataPreviewText, /agentic-local-fixture/);
    assert.match(dataPreviewText, /fixture-confirmed-nest/);

    const run = await runStore.get(created.proposal.run.id);
    assert.ok(run?.events.some((event) => event.type === "external-action-executor-build-completed"));
    assert.ok(run?.events.some((event) => event.type === "external-action-executor-attached"));
    assert.ok(run?.events.some((event) => event.type === "external-action-committed"));
  } finally {
    await closeFixture(fixture);
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Nest API prepares external actions through browser operate", async () => {
  const fixture = await createNestFixture();
  try {
    const runStore = fixture.app.get<RunStore>(RUN_STORE);
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const browserInputs: Record<string, unknown>[] = [];
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser preparation tool.",
      capabilities: ["browser-operate", "browser-automation"],
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          prepareOnly: { type: "boolean" },
          commands: { type: "array" },
        },
        required: ["url"],
      },
      async run(input) {
        browserInputs.push(input);
        assert.equal(input.prepareOnly, true);
        assert.equal(input.url, "https://example.com/reserve");
        return {
          ok: true,
          content: "Prepared page and captured proof.",
          data: {
            finalUrl: input.url,
            pageTitle: "Fixture booking page",
            extractedText: "Reserve a table for two. Confirm reservation button is visible.",
            links: [{ text: "Restaurant policy", href: "https://example.com/policy" }],
            steps: [{ index: 0, action: "navigate", ok: true, detail: input.url }],
            artifacts: [
              {
                filename: "prepare.txt",
                mimeType: "text/plain",
                content: Buffer.from("prepared fixture").toString("base64"),
                description: "fixture proof",
              },
            ],
          },
        };
      },
    });

    const run = await runStore.create("Подготовь бронирование", {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
    });
    const proposal: ExternalActionProposal = {
      id: `action_${run.id}_prepare`,
      runId: run.id,
      actionType: "reservation",
      status: "proposed",
      title: "Reservation proposal: Prepare",
      summary: "reservation: prepare before approval",
      proposedAction: "Prepare the reservation page without final submit.",
      target: "https://example.com/reserve",
      approvalRequired: true,
      userExplicitlyForbidsAction: false,
      allowedWithoutApproval: ["open page", "fill draft fields"],
      prohibitedWithoutApproval: ["submit final booking"],
      sourceUrls: ["https://example.com/article", "https://example.com/reserve"],
      artifactIds: [],
      preparation: {
        stage: "prepared_for_approval",
        objective: "Prepare reservation draft.",
        target: "Example",
        targetUrl: "https://example.com/reserve",
        collectedInputs: [
          { label: "party_size", value: "2", source: "user_request" },
          { label: "date_or_time", value: "2026-05-23 20:00", source: "user_request" },
        ],
        missingInputs: [],
        commitBoundary: "Do not click the final submit button.",
        operatorChecklist: ["Review details before approval."],
        proofPlan: ["screenshot"],
      },
      createdAt: new Date().toISOString(),
      createdBy: "base-agent",
    };
    await runStore.complete(run.id, {
      finalAnswer: "Prepared reservation proposal.",
      complexity: {
        mode: "direct",
        reason: "fixture",
        domains: [],
        riskLevel: "medium",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: [],
      actionProposals: [proposal],
    });
    await runStore.appendEvent(run.id, {
      id: "proposal-created-prepare",
      spanId: "proposal-created-prepare",
      type: "external-action-proposal-created",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "External action proposal created",
      timestamp: new Date().toISOString(),
      payload: { proposalId: proposal.id },
    });

    const prepared = await requestJson<{
      proposal: {
        preparationExecution?: {
          status: string;
          toolName?: string;
          artifactIds?: string[];
          contentPreview?: string;
          preparedSession?: {
            currentUrl?: string;
            pageTitle?: string;
            textPreview?: string;
            links: Array<{ href: string }>;
            replaySteps: Array<Record<string, unknown>>;
            commitCandidates: Array<Record<string, unknown>>;
          };
        };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(proposal.id)}/prepare`,
      { method: "POST" },
    );
    assert.equal(prepared.proposal.preparationExecution?.status, "completed");
    assert.equal(prepared.proposal.preparationExecution?.toolName, "browser.operate");
    assert.match(prepared.proposal.preparationExecution?.contentPreview ?? "", /Prepared page/);
    assert.equal(prepared.proposal.preparationExecution?.artifactIds?.length, 1);
    assert.equal(prepared.proposal.preparationExecution?.preparedSession?.currentUrl, "https://example.com/reserve");
    const firstBrowserCommands = Array.isArray(browserInputs[0]?.commands)
      ? (browserInputs[0]?.commands as Array<Record<string, unknown>>)
      : [];
    assert.deepEqual(
      firstBrowserCommands.filter((command) => command.action === "fill"),
      [],
    );
    assert.equal(prepared.proposal.preparationExecution?.preparedSession?.pageTitle, "Fixture booking page");
    assert.match(prepared.proposal.preparationExecution?.preparedSession?.textPreview ?? "", /Reserve a table/);
    assert.equal(prepared.proposal.preparationExecution?.preparedSession?.links.length, 1);
    assert.ok((prepared.proposal.preparationExecution?.preparedSession?.replaySteps.length ?? 0) > 0);
    assert.ok((prepared.proposal.preparationExecution?.preparedSession?.commitCandidates.length ?? 0) > 0);

    const replayed = await requestJson<{
      proposal: { preparationExecution?: { status: string; preparedSession?: { currentUrl?: string } } };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(proposal.id)}/prepare`,
      { method: "POST", body: JSON.stringify({ mode: "replay" }) },
    );
    assert.equal(replayed.proposal.preparationExecution?.status, "completed");
    assert.equal(replayed.proposal.preparationExecution?.preparedSession?.currentUrl, "https://example.com/reserve");
    assert.equal(browserInputs.length, 2);
    assert.deepEqual(browserInputs[1]?.commands, browserInputs[0]?.commands);

    await requestJson(fixture.baseUrl, `/api/action-proposals/${encodeURIComponent(proposal.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ reason: "test approval" }),
    });
    await requestJson(fixture.baseUrl, `/api/action-proposals/${encodeURIComponent(proposal.id)}/build-executor`, {
      method: "POST",
      body: JSON.stringify({ mode: "plan" }),
    });

    const updated = await runStore.get(run.id);
    assert.ok(updated?.events.some((event) => event.type === "external-action-preparation-started"));
    assert.ok(updated?.events.some((event) => event.type === "external-action-preparation-completed"));
    assert.ok(updated?.events.some((event) => event.type === "artifact-created"));
    const buildEvent = [...(updated?.events ?? [])].reverse().find(
      (event) =>
        event.type === "external-action-executor-build-requested" ||
        event.type === "external-action-executor-attached",
    );
    const buildPayload = buildEvent?.payload as
      | { buildRequest?: { toolInput?: { preparedSession?: { currentUrl?: string }; replaySteps?: unknown[] } } }
      | undefined;
    assert.equal(buildPayload?.buildRequest?.toolInput?.preparedSession?.currentUrl, "https://example.com/reserve");
    assert.ok((buildPayload?.buildRequest?.toolInput?.replaySteps?.length ?? 0) > 0);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API commits approved external actions through a generated commit tool", async () => {
  const fixture = await createNestFixture();
  try {
    const runStore = fixture.app.get<RunStore>(RUN_STORE);
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const commitInputs: Record<string, unknown>[] = [];
    registry.register({
      name: "generated.action.commit.echo",
      version: "0.1.0",
      description: "Fixture external action commit executor.",
      capabilities: ["external-action-commit", "external-action-commit-generic"],
      inputSchema: {
        type: "object",
        properties: {
          reservationId: { type: "string" },
        },
        required: ["reservationId"],
      },
      async run(input) {
        commitInputs.push(input);
        return {
          ok: true,
          content: `Committed reservation ${String(input.reservationId)}`,
          data: {
            provider: "fixture",
            confirmationId: "conf_fixture_1",
          },
        };
      },
    });

    const run = await runStore.create("Забронируй столик", {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
    });
    const proposal: ExternalActionProposal = {
      id: `action_${run.id}_1`,
      runId: run.id,
      actionType: "reservation",
      status: "proposed",
      title: "Reservation proposal: Test",
      summary: "reservation: prepare booking",
      proposedAction: "Submit fixture reservation after approval.",
      target: "Test",
      approvalRequired: true,
      userExplicitlyForbidsAction: false,
      allowedWithoutApproval: ["prepare draft"],
      prohibitedWithoutApproval: ["submit a reservation"],
      sourceUrls: [],
      artifactIds: [],
      commitExecutor: {
        kind: "generated_tool",
        toolName: "generated.action.commit.echo",
        toolVersion: "0.1.0",
        toolInput: { reservationId: "draft_1" },
        ready: true,
        risk: "high",
        reason: "Fixture commit tool passed QA.",
        missing: [],
        expectedProof: ["provider confirmation"],
      },
      createdAt: new Date().toISOString(),
      createdBy: "base-agent",
    };
    const result: AgentRunResult = {
      finalAnswer: "Prepared reservation proposal.",
      complexity: {
        mode: "direct",
        reason: "fixture",
        domains: [],
        riskLevel: "medium",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: [],
      actionProposals: [proposal],
    };
    await runStore.complete(run.id, result);
    await runStore.appendEvent(run.id, {
      id: "proposal-prepared-for-commit",
      spanId: "proposal-prepared-for-commit",
      type: "external-action-preparation-completed",
      actor: "browser.operate",
      activity: "tool",
      status: "completed",
      title: "External action preparation completed",
      detail: "Prepared fixture page.",
      timestamp: new Date().toISOString(),
      payload: {
        proposalId: proposal.id,
        artifactIds: ["artifact_prepare_1"],
        preparedSession: {
          preparedAt: new Date().toISOString(),
          toolName: "browser.operate",
          toolVersion: "0.1.0",
          currentUrl: "https://example.com/reserve",
          pageTitle: "Fixture booking page",
          textPreview: "Reservation draft ready.",
          links: [],
          filledFields: [{ label: "Name", valuePreview: "Dmitrii" }],
          replaySteps: [{ action: "fill", selector: "#name", value: "Dmitrii" }],
          commitCandidates: [{ label: "Confirm", reason: "final submit" }],
          artifactIds: ["artifact_prepare_1"],
          warnings: [],
        },
      },
    });

    await requestJson(fixture.baseUrl, `/api/action-proposals/${encodeURIComponent(proposal.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ reason: "test approval" }),
    });
    const committed = await requestJson<{
      proposal: {
        proposal: { status: string };
        execution?: { status: string; toolName?: string; contentPreview?: string };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(proposal.id)}/commit`,
      { method: "POST" },
    );
    assert.equal(committed.proposal.proposal.status, "committed");
    assert.equal(committed.proposal.execution?.status, "committed");
    assert.equal(committed.proposal.execution?.toolName, "generated.action.commit.echo");
    assert.match(committed.proposal.execution?.contentPreview ?? "", /Committed reservation draft_1/);
    assert.equal(commitInputs[0]?.proposalId, proposal.id);
    assert.equal(
      (commitInputs[0]?.preparedSession as { currentUrl?: string } | undefined)
        ?.currentUrl,
      "https://example.com/reserve",
    );
    assert.deepEqual(commitInputs[0]?.artifactIds, ["artifact_prepare_1"]);

    const updated = await runStore.get(run.id);
    assert.ok(updated?.events.some((event) => event.type === "external-action-commit-started"));
    assert.ok(updated?.events.some((event) => event.type === "external-action-committed"));
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API validates request bodies on the remaining base surfaces", async () => {
  const fixture = await createNestFixture();
  try {
    const invalidJson = await fetch(`${fixture.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(invalidJson.status, 400);
    assert.match(await invalidJson.text(), /JSON|Unexpected|property/i);

    await requestJson(fixture.baseUrl, "/api/memories", {
      method: "POST",
      expectedStatus: 400,
      body: JSON.stringify({
        title: "",
        summary: "summary",
        reusableProcedure: "procedure",
      }),
    });
  } finally {
    await closeFixture(fixture);
  }
});
