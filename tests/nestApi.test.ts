import "reflect-metadata";

import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BadRequestException, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "../src/server/app.module.js";
import { ApiExceptionFilter } from "../src/server/common/filters/api-exception.filter.js";

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

  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
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
    .setDescription("Coordinator + tool registry + run lifecycle for the Agentic platform.")
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

test("Nest API serves health, OpenAPI, static UI, and tool rework/retry endpoints", async () => {
  const fixture = await createNestFixture();
  try {
    const health = await requestJson<{ ok: boolean }>(fixture.baseUrl, "/api/health");
    assert.equal(health.ok, true);

    const openapi = await requestJson<{ openapi: string; info: { title: string } }>(
      fixture.baseUrl,
      "/api/docs-json",
    );
    assert.match(openapi.openapi, /^3\./);
    assert.equal(openapi.info.title, "Agentic Universal Agent API");

    const index = await fetch(`${fixture.baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Agentic|html/i);

    const runCreated = await requestJson<{ run: { id: string; status: string } }>(
      fixture.baseUrl,
      "/api/runs",
      {
        method: "POST",
        expectedStatus: 202,
        body: JSON.stringify({
          task: "manual nest e2e smoke for tool rework",
          channel: "web",
          requesterUserId: "user-admin",
        }),
      },
    );
    assert.match(runCreated.run.id, /^run_/);

    const investigation = await requestJson<{ investigation: { id: string; contextBundle: unknown } }>(
      fixture.baseUrl,
      "/api/tool-investigations",
      {
        method: "POST",
        expectedStatus: 201,
        body: JSON.stringify({
          source: "trace_span",
          status: "open",
          runId: runCreated.run.id,
          spanId: "span-nest-e2e",
          toolName: "browser.operate",
          title: "Browser operate needs deterministic rework",
          description: "Nested API e2e canary",
          contextBundle: {
            apiKey: "DO-NOT-LEAK-NEST-E2E",
            span: { id: "span-nest-e2e" },
          },
        }),
      },
    );
    assert.match(investigation.investigation.id, /^inv_/);
    assert.equal(JSON.stringify(investigation).includes("DO-NOT-LEAK-NEST-E2E"), false);

    const promoted = await requestJson<{
      request: { id: string; capability: string; replacesToolName?: string };
      wait: { id: string; status: string; runId: string };
    }>(fixture.baseUrl, `/api/tool-investigations/${investigation.investigation.id}/promote`, {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({}),
    });
    assert.equal(promoted.request.capability, "browser-operate");
    assert.equal(promoted.request.replacesToolName, "browser.operate");
    assert.equal(promoted.wait.status, "waiting");
    assert.equal(promoted.wait.runId, runCreated.run.id);

    const buildAfterRegistration = await requestJson<{ request: { id: string; status: string } }>(
      fixture.baseUrl,
      `/api/tool-build-requests/${promoted.request.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "registered", registeredVersion: "1.1.0" }),
      },
    );
    assert.equal(buildAfterRegistration.request.status, "registered");

    const waitAfterRegistration = await requestJson<{ wait: { id: string; status: string } }>(
      fixture.baseUrl,
      `/api/tool-rework-waits/${promoted.wait.id}`,
    );
    assert.equal(waitAfterRegistration.wait.status, "promoted");

    const retry = await requestJson<{ status: string; retryRun: { id: string; parentRunId: string } }>(
      fixture.baseUrl,
      `/api/tool-rework-waits/${promoted.wait.id}/retry-run`,
      { method: "POST", expectedStatus: 201, body: JSON.stringify({}) },
    );
    assert.equal(retry.status, "created");
    assert.equal(retry.retryRun.parentRunId, runCreated.run.id);

    const audit = await requestJson<{ events: unknown[] }>(fixture.baseUrl, "/api/audit-events?limit=100");
    assert.equal(JSON.stringify(audit).includes("DO-NOT-LEAK-NEST-E2E"), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API validates tool build inputs and stores inline credentials as secret handles", async () => {
  const fixture = await createNestFixture();
  try {
    const request = await requestJson<{
      request: { id: string; capability: string; credentialHandles: string[]; reason: string };
    }>(fixture.baseUrl, "/api/tool-build-requests", {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({
        displayName: "Generic API smoke",
        reason: "Create an API tool. api key: NEST-RAW-SECRET-12345",
        qaCriteria: ["smoke call passes"],
      }),
    });
    assert.equal(request.request.reason.includes("NEST-RAW-SECRET-12345"), false);
    assert.equal(request.request.credentialHandles.some((handle) => handle.startsWith("secret.")), true);

    const secrets = await requestJson<{ secrets: unknown[] }>(fixture.baseUrl, "/api/secret-handles");
    assert.equal(JSON.stringify(secrets).includes("NEST-RAW-SECRET-12345"), false);

    const wrongTarget = await fetch(`${fixture.baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Telegram bot rework",
        reason: "Improve Telegram bot message delivery",
        replacesToolName: "browser.operate",
      }),
    });
    assert.equal(wrongTarget.status, 400);
    assert.match(await wrongTarget.text(), /target|selected|tool/i);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API persists work ledger, evidence ledger, and run retrospectives with redacted metadata", async () => {
  const fixture = await createNestFixture();
  try {
    const runCreated = await requestJson<{ run: { id: string; threadId: string } }>(
      fixture.baseUrl,
      "/api/runs",
      {
        method: "POST",
        expectedStatus: 202,
        body: JSON.stringify({
          task: "manual nest ledger smoke",
          channel: "web",
          requesterUserId: "user-admin",
        }),
      },
    );

    const work = await requestJson<{ item: { id: string; metadata: Record<string, unknown> } }>(
      fixture.baseUrl,
      "/api/work-ledger",
      {
        method: "POST",
        expectedStatus: 201,
        body: JSON.stringify({
          runId: runCreated.run.id,
          threadId: runCreated.run.threadId,
          kind: "search",
          status: "claimed",
          workKey: "search:nest-e2e",
          title: "Nest search work",
          metadata: { apiKey: "WL-NEST-E2E-CANARY" },
        }),
      },
    );
    assert.equal(work.item.metadata.apiKey, "[redacted]");

    const evidence = await requestJson<{ record: { id: string; metadata: Record<string, unknown> } }>(
      fixture.baseUrl,
      "/api/evidence-ledger",
      {
        method: "POST",
        expectedStatus: 201,
        body: JSON.stringify({
          runId: runCreated.run.id,
          threadId: runCreated.run.threadId,
          workItemId: work.item.id,
          kind: "search_result",
          title: "Nest evidence",
          summary: "Evidence summary",
          metadata: { token: "EV-NEST-E2E-CANARY" },
        }),
      },
    );
    assert.equal(evidence.record.metadata.token, "[redacted]");

    const linked = await requestJson<{ item: { evidenceIds: string[] } }>(
      fixture.baseUrl,
      `/api/work-ledger/${work.item.id}/evidence`,
      { method: "POST", expectedStatus: 201, body: JSON.stringify({ evidenceId: evidence.record.id }) },
    );
    assert.deepEqual(linked.item.evidenceIds, [evidence.record.id]);

    const retrospective = await requestJson<{
      record: { id: string; metadata: Record<string, unknown>; runOutcome: string };
    }>(fixture.baseUrl, "/api/run-retrospectives", {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({
        runId: runCreated.run.id,
        threadId: "thread-nest-e2e",
        runOutcome: "completed",
        summary: "Nest retrospective",
        whatWorked: ["HTTP smoke"],
        metadata: { secret: "RETRO-NEST-E2E-CANARY" },
      }),
    });
    assert.equal(retrospective.record.runOutcome, "completed");
    assert.equal(retrospective.record.metadata.secret, "[redacted]");

    const audit = await requestJson<{ events: unknown[] }>(fixture.baseUrl, "/api/audit-events?limit=100");
    const auditJson = JSON.stringify(audit);
    assert.equal(auditJson.includes("WL-NEST-E2E-CANARY"), false);
    assert.equal(auditJson.includes("EV-NEST-E2E-CANARY"), false);
    assert.equal(auditJson.includes("RETRO-NEST-E2E-CANARY"), false);
  } finally {
    await closeFixture(fixture);
  }
});
