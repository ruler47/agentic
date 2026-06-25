import "reflect-metadata";

import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BadRequestException, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, type NextFunction, type Request, type Response } from "express";
import { AppModule } from "../src/server/app.module.js";
import { ApiExceptionFilter } from "../src/server/common/filters/api-exception.filter.js";
import { TOOL_REGISTRY } from "../src/server/persistence/tokens.js";
import type { ToolRegistry } from "../src/tools/registry.js";

type Fixture = { app: INestApplication; baseUrl: string };

test("fixture external-action proposal prepares a safe draft in browser.operate", async () => {
  const fixture = await createFixture();
  try {
    const html = await requestText(fixture.baseUrl, "/api/fixtures/external-actions/reservation");
    assert.match(html, /Confirm reservation/);

    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const browserInputs: Record<string, unknown>[] = [];
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        browserInputs.push(input);
        const commands = input.commands as Array<Record<string, unknown>>;
        assert.equal(input.prepareOnly, true);
        assert.match(String(input.url), /\/api\/fixtures\/external-actions\/reservation$/);
        assert.deepEqual(
          commands.filter((command) => command.action === "fill").map((command) => command.label),
          ["Name", "Party size", "Date", "Time", "Notes"],
        );
        assert.equal(commands.some((command) => command.action === "click"), false);
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: {
            finalUrl: input.url,
            pageTitle: "Restaurant reservation fixture",
            extractedText: "Draft is filled. Confirm reservation remains the final boundary.",
            links: [],
            steps: commands.map((command, index) => ({
              index,
              action: String(command.action),
              ok: true,
              detail: String(command.label ?? command.action),
            })),
          },
        };
      },
    });

    const created = await requestJson<{
      proposal: { proposal: { id: string; sourceUrls: string[] } };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({ actionType: "reservation" }),
      expectedStatus: 201,
    });
    assert.match(created.proposal.proposal.sourceUrls[0] ?? "", /external-actions\/reservation$/);

    const prepared = await requestJson<{
      proposal: {
        preparationExecution?: {
          status: string;
          preparedSession?: { filledFields: Array<{ label?: string }> };
        };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${encodeURIComponent(created.proposal.proposal.id)}/prepare`,
      { method: "POST" },
    );
    assert.equal(prepared.proposal.preparationExecution?.status, "completed");
    assert.deepEqual(
      prepared.proposal.preparationExecution?.preparedSession?.filledFields.map((field) => field.label),
      ["Name", "Party size", "Date", "Time", "Notes"],
    );
    assert.equal(browserInputs.length, 1);
  } finally {
    await fixture.app.close();
  }
});

test("fixture external-action approval mode pauses and resumes the same run on rejection", async () => {
  const fixture = await createFixture();
  try {
    const created = await requestJson<{
      proposal: {
        proposal: { id: string; executionMode?: string; approvalRequired: boolean };
        run: { id: string; status: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({ actionType: "reservation" }),
      expectedStatus: 201,
    });

    assert.equal(created.proposal.proposal.executionMode, "approval");
    assert.equal(created.proposal.proposal.approvalRequired, true);
    assert.equal(created.proposal.run.status, "waiting_approval");

    await requestJson(fixture.baseUrl, `/api/action-proposals/${created.proposal.proposal.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "fixture rejection" }),
    });

    const fetched = await requestJson<{
      run: { status: string; result?: { finalAnswer?: string; actionProposals?: Array<{ status: string }> } };
    }>(fixture.baseUrl, `/api/runs/${created.proposal.run.id}`);
    assert.equal(fetched.run.status, "completed");
    assert.match(fetched.run.result?.finalAnswer ?? "", /External action did not run/);
    assert.equal(fetched.run.result?.actionProposals?.[0]?.status, "rejected");
  } finally {
    await fixture.app.close();
  }
});

test("fixture external-action approval mode resumes the same run after approved commit", async () => {
  const fixture = await createFixture();
  try {
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const target = `${fixture.baseUrl}/api/fixtures/external-actions/reservation`;
    const commitInputs: Record<string, unknown>[] = [];
    const prepareInputs: Record<string, unknown>[] = [];
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        prepareInputs.push(input);
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: {
            finalUrl: input.url,
            pageTitle: "Restaurant reservation fixture",
            extractedText: "Draft is filled. Confirm reservation remains the final boundary.",
            links: [],
            actionCandidates: [
              {
                text: "Confirm reservation",
                selector: "#confirm",
              },
            ],
            steps: Array.isArray(input.commands)
              ? input.commands.map((command: Record<string, unknown>, index: number) => ({
                  index,
                  action: String(command.action),
                  ok: true,
                  detail: String(command.label ?? command.action),
                }))
              : [],
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
    registry.register({
      name: "external.action.commit",
      version: "0.1.0",
      description: "Universal fixture external-action commit executor.",
      capabilities: [
        "external-action-commit",
        "external-action-commit-generic",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        commitInputs.push(input);
        return {
          ok: true,
          content: "Fixture reservation committed: manual-fixture-confirmed",
          data: {
            provider: "agentic-local-fixture",
            confirmationId: "manual-fixture-confirmed",
          },
        };
      },
    });

    const created = await requestJson<{
      proposal: {
        proposal: { id: string; status: string; commitExecutor?: { ready?: boolean } };
        run: { id: string; status: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({
        actionType: "reservation",
        fixtureBaseUrl: fixture.baseUrl,
        mode: "approval",
      }),
      expectedStatus: 201,
    });
    assert.equal(created.proposal.run.status, "waiting_approval");
    assert.equal(created.proposal.proposal.status, "proposed");

    const approved = await requestJson<{
      proposal: { proposal: { status: string; commitExecutor?: { ready?: boolean; toolName?: string } } };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "manual fixture approval" }),
      },
    );
    assert.equal(approved.proposal.proposal.status, "approved");
    assert.equal(approved.proposal.proposal.commitExecutor?.ready, true);
    assert.equal(
      approved.proposal.proposal.commitExecutor?.toolName,
      "external.action.commit",
    );
    assert.equal(prepareInputs.length, 1);

    const committed = await requestJson<{
      proposal: {
        proposal: { status: string };
        run: { id: string; status: string };
        execution?: { status: string; contentPreview?: string };
        finalReport?: { status: string; summary: string; proofArtifactIds: string[] };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/commit`,
      {
        method: "POST",
        body: JSON.stringify({
          input: { fixtureConfirmation: "manual-fixture-confirmed" },
        }),
      },
    );
    assert.equal(committed.proposal.proposal.status, "committed");
    assert.equal(committed.proposal.run.status, "completed");
    assert.equal(committed.proposal.execution?.status, "committed");
    assert.equal(committed.proposal.finalReport?.status, "committed");
    assert.match(committed.proposal.finalReport?.summary ?? "", /manual-fixture-confirmed/);
    assert.match(committed.proposal.execution?.contentPreview ?? "", /manual-fixture-confirmed/);
    assert.equal(commitInputs[0]?.proposalId, created.proposal.proposal.id);
    assert.deepEqual(commitInputs[0]?.operatorInput, {
      fixtureConfirmation: "manual-fixture-confirmed",
    });

    const fetched = await requestJson<{
      run: { status: string; result?: { finalAnswer?: string; actionProposals?: Array<{ status: string }> }; events: Array<{ type: string }> };
    }>(fixture.baseUrl, `/api/runs/${created.proposal.run.id}`);
    assert.equal(fetched.run.status, "completed");
    assert.match(fetched.run.result?.finalAnswer ?? "", /External action completed/);
    assert.match(fetched.run.result?.finalAnswer ?? "", /manual-fixture-confirmed/);
    assert.equal(fetched.run.result?.actionProposals?.[0]?.status, "committed");
    assert.ok(fetched.run.events.some((event) => event.type === "external-action-executor-attached"));
    assert.ok(fetched.run.events.some((event) => event.type === "external-action-approval-auto-advance-completed"));
    assert.ok(fetched.run.events.some((event) => event.type === "external-action-committed"));
    assert.ok(
      fetched.run.events.some(
        (event) => event.type === "external-action-final-report-created",
      ),
    );
  } finally {
    await fixture.app.close();
  }
});

test("approved external-action proposal can be cancelled before final submit", async () => {
  const fixture = await createFixture();
  try {
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: {
            finalUrl: input.url,
            pageTitle: "Restaurant reservation fixture",
            extractedText: "Draft is filled. Confirm reservation remains the final boundary.",
            links: [],
            actionCandidates: [{ text: "Confirm reservation", selector: "#confirm" }],
            steps: [],
          },
        };
      },
    });

    const created = await requestJson<{
      proposal: {
        proposal: { id: string; status: string };
        run: { id: string; status: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({
        actionType: "reservation",
        fixtureBaseUrl: fixture.baseUrl,
        mode: "approval",
      }),
      expectedStatus: 201,
    });

    const approved = await requestJson<{
      proposal: { proposal: { status: string }; run: { status: string } };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "prepare only" }),
      },
    );
    assert.equal(approved.proposal.proposal.status, "approved");
    assert.equal(approved.proposal.run.status, "waiting_approval");

    const cancelled = await requestJson<{
      proposal: { proposal: { status: string }; run: { status: string } };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "cancel before submit" }),
      },
    );
    assert.equal(cancelled.proposal.proposal.status, "rejected");
    assert.equal(cancelled.proposal.run.status, "completed");

    const fetched = await requestJson<{
      run: {
        status: string;
        result?: { finalAnswer?: string; actionProposals?: Array<{ status: string }> };
      };
    }>(fixture.baseUrl, `/api/runs/${created.proposal.run.id}`);
    assert.equal(fetched.run.status, "completed");
    assert.match(fetched.run.result?.finalAnswer ?? "", /External action did not run/);
    assert.equal(fetched.run.result?.actionProposals?.[0]?.status, "rejected");
  } finally {
    await fixture.app.close();
  }
});

test("profile field approval replays preparation before final submit", async () => {
  const fixture = await createFixture();
  try {
    await requestJson(fixture.baseUrl, "/api/users/user-admin/channel-identities", {
      method: "POST",
      body: JSON.stringify({
        provider: "fixture-profile",
        providerUserId: "user-admin-profile",
        allowStatus: "allowed",
        displayMetadata: { email: "dmitrii@example.com" },
      }),
      expectedStatus: 201,
    });

    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const prepareInputs: Record<string, unknown>[] = [];
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        prepareInputs.push(input);
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: {
            finalUrl: input.url,
            pageTitle: "Appointment fixture",
            extractedText: "Draft is filled. Confirm appointment remains the final boundary.",
            links: [],
            forms: [
              {
                fields: [
                  { label: "Name", name: "name", type: "text" },
                  { label: "Email", name: "email", type: "email", required: true },
                ],
                submitCandidates: [{ text: "Confirm appointment", selector: "#confirm" }],
              },
            ],
            steps: Array.isArray(input.commands)
              ? input.commands.map((command: Record<string, unknown>, index: number) => ({
                  index: index + 1,
                  action: String(command.action),
                  ok: true,
                  detail: String(command.label ?? command.action),
                }))
              : [],
            artifacts: [
              {
                filename: "appointment-draft-proof.txt",
                mimeType: "text/plain",
                content: Buffer.from("Prepared appointment draft proof"),
                description: "Fixture proof artifact for prepared appointment draft.",
              },
            ],
          },
        };
      },
    });
    registry.register({
      name: "external.action.commit",
      version: "0.1.0",
      description: "Universal fixture external-action commit executor.",
      capabilities: [
        "external-action-commit",
        "external-action-commit-generic",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run() {
        return {
          ok: true,
          content: "Fixture appointment committed.",
          data: { confirmationId: "unused" },
        };
      },
    });

    const created = await requestJson<{
      proposal: {
        proposal: { id: string };
        run: { id: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({
        actionType: "appointment",
        fixtureBaseUrl: fixture.baseUrl,
        mode: "approval",
      }),
      expectedStatus: 201,
    });

    const approved = await requestJson<{
      proposal: {
        preparationExecution?: {
          preparedSession?: {
            formFieldGaps?: Array<{ field?: string; profileAvailable?: boolean }>;
          };
        };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "manual fixture approval" }),
      },
    );
    assert.equal(prepareInputs.length, 1);
    assert.equal(
      approved.proposal.preparationExecution?.preparedSession?.formFieldGaps?.some(
        (gap) => gap.field === "contact_email" && gap.profileAvailable,
      ),
      true,
    );

    const hydrated = await requestJson<{
      proposal: {
        profileHydration?: { fields: Array<{ field: string; valuePreview: string }> };
        preparationExecution?: {
          preparedSession?: {
            filledFields: Array<{ label?: string; valuePreview?: string }>;
            approvedProfileFields?: Array<{ field: string; valuePreview: string }>;
          };
        };
      };
    }>(
      fixture.baseUrl,
      `/api/action-proposals/${created.proposal.proposal.id}/profile-hydration/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          fields: ["contact_email"],
          reason: "approve fixture profile hydration",
        }),
      },
    );

    assert.equal(prepareInputs.length, 2);
    const replayCommands = prepareInputs[1]?.commands as Record<string, unknown>[];
    assert.equal(
      replayCommands.some(
        (command) =>
          command.source === "approved_profile" &&
          command.field === "contact_email" &&
          command.value === "dmitrii@example.com",
      ),
      true,
    );
    assert.deepEqual(hydrated.proposal.profileHydration?.fields.map((field) => field.field), [
      "contact_email",
    ]);
    assert.equal(
      hydrated.proposal.preparationExecution?.preparedSession?.approvedProfileFields?.some(
        (field) => field.field === "contact_email" && field.valuePreview === "dm***@example.com",
      ),
      true,
    );
    assert.equal(
      hydrated.proposal.preparationExecution?.preparedSession?.filledFields.some(
        (field) => field.label === "Email" && field.valuePreview === "dm***@example.com",
      ),
      true,
    );
  } finally {
    await fixture.app.close();
  }
});

test("fixture external-action automode blocks clearly when no executor exists", async () => {
  const fixture = await createFixture();
  try {
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    registry.unregister("external.action.commit");
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: preparedFixtureDraftData(input),
        };
      },
    });
    const created = await requestJson<{
      proposal: {
        proposal: { executionMode?: string; approvalRequired: boolean; prohibitedWithoutApproval: string[] };
        run: { id: string; status: string };
        execution?: { status: string; reason?: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({
        actionType: "reservation",
        fixtureBaseUrl: fixture.baseUrl,
        mode: "auto",
      }),
      expectedStatus: 201,
    });

    assert.equal(created.proposal.proposal.executionMode, "auto");
    assert.equal(created.proposal.proposal.approvalRequired, false);
    assert.deepEqual(created.proposal.proposal.prohibitedWithoutApproval, []);
    assert.equal(created.proposal.run.status, "completed");
    assert.equal(created.proposal.execution?.status, "blocked");
    assert.match(
      created.proposal.execution?.reason ?? "",
      /No generated fixture commit executor|generated commit tool|missing_requirements/i,
    );
    const fetched = await requestJson<{
      run: { result?: { finalAnswer?: string } };
    }>(fixture.baseUrl, `/api/runs/${created.proposal.run.id}`);
    assert.match(fetched.run.result?.finalAnswer ?? "", /Automode external action result/);
    assert.match(fetched.run.result?.finalAnswer ?? "", /did not submit/);
  } finally {
    await fixture.app.close();
  }
});

test("fixture external-action automode attaches an existing executor and commits", async () => {
  const fixture = await createFixture();
  try {
    const registry = fixture.app.get<ToolRegistry>(TOOL_REGISTRY);
    const target = `${fixture.baseUrl}/api/fixtures/external-actions/reservation`;
    registry.register({
      name: "browser.operate",
      version: "0.1.0",
      description: "Fixture browser operate.",
      capabilities: [
        "browser-operate",
        "browser-automation",
        "browser-field-candidates",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        return {
          ok: true,
          content: "Prepared fixture draft without final commit.",
          data: preparedFixtureDraftData(input),
        };
      },
    });
    registry.register({
      name: "external.action.commit",
      version: "0.1.0",
      description: "Universal fixture external-action commit executor.",
      capabilities: [
        "external-action-commit",
        "external-action-commit-generic",
      ],
      inputSchema: { type: "object", properties: {}, required: [] },
      async run(input) {
        assert.equal(input.target, target);
        return {
          ok: true,
          content: "Fixture reservation committed: fixture-auto-confirmed",
          data: {
            provider: "agentic-local-fixture",
            confirmationId: "fixture-auto-confirmed",
            submittedPayloadSummary: JSON.stringify(input).slice(0, 200),
          },
        };
      },
    });
    const created = await requestJson<{
      proposal: {
        proposal: { status: string; commitExecutor?: { toolName?: string; ready?: boolean } };
        run: { id: string; status: string };
        execution?: { status: string; contentPreview?: string };
      };
    }>(fixture.baseUrl, "/api/action-proposals/fixture", {
      method: "POST",
      body: JSON.stringify({
        actionType: "reservation",
        fixtureBaseUrl: fixture.baseUrl,
        mode: "auto",
      }),
      expectedStatus: 201,
    });
    assert.equal(created.proposal.run.status, "completed");
    assert.equal(created.proposal.proposal.status, "committed");
    assert.equal(created.proposal.proposal.commitExecutor?.ready, true);
    assert.equal(created.proposal.execution?.status, "committed");
    assert.match(created.proposal.execution?.contentPreview ?? "", /fixture-auto-confirmed/);
    const fetched = await requestJson<{
      run: { result?: { finalAnswer?: string }; events: Array<{ type: string }> };
    }>(fixture.baseUrl, `/api/runs/${created.proposal.run.id}`);
    assert.match(fetched.run.result?.finalAnswer ?? "", /Automode external action result/);
    assert.match(fetched.run.result?.finalAnswer ?? "", /committed/);
    assert.ok(fetched.run.events.some((event) => event.type === "external-action-executor-attached"));
    assert.ok(fetched.run.events.some((event) => event.type === "external-action-committed"));
  } finally {
    await fixture.app.close();
  }
});

function preparedFixtureDraftData(input: Record<string, unknown>): Record<string, unknown> {
  return {
    finalUrl: input.url,
    pageTitle: "Restaurant reservation fixture",
    extractedText: "Draft is filled. Confirm reservation remains the final boundary.",
    links: [],
    actionCandidates: [
      {
        text: "Confirm reservation",
        selector: "#confirm",
      },
    ],
    steps: Array.isArray(input.commands)
      ? input.commands.map((command: Record<string, unknown>, index: number) => ({
          index,
          action: String(command.action),
          ok: true,
          detail: String(command.label ?? command.action),
        }))
      : [],
    artifacts: [
      {
        filename: "reservation-draft-proof.txt",
        mimeType: "text/plain",
        content: Buffer.from("Prepared reservation draft proof"),
        description: "Fixture proof artifact for prepared reservation draft.",
      },
    ],
  };
}

async function createFixture(): Promise<Fixture> {
  process.env.TOOL_BUILD_WORKER = "disabled";
  process.env.LLM_BASE_URL = "http://127.0.0.1:65000/v1";
  process.env.LLM_MODEL = "offline";
  process.env.DATABASE_URL = "";
  process.env.TOOL_BUILD_MIGRATION_QA_DATABASE_URL = "";
  process.env.BUILTIN_TOOLS = "disabled";
  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
  app.use(json());
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };
    if (candidate?.type === "entity.parse.failed" || candidate?.status === 400 || candidate?.statusCode === 400) {
      response.status(400).type("application/json").send({ error: String(candidate.message ?? "parse failed") });
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
      exceptionFactory: (errors) =>
        new BadRequestException(
          errors.flatMap((error) => Object.values(error.constraints ?? {}))[0] ?? "Validation failed",
        ),
    }),
  );
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestText(baseUrl: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return body;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { expectedStatus?: number } = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  assert.equal(response.status, options.expectedStatus ?? 200, `${path}: ${body}`);
  return body ? (JSON.parse(body) as T) : ({} as T);
}
