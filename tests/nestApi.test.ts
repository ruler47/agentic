import "reflect-metadata";

import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BadRequestException, type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, type NextFunction, type Request, type Response } from "express";
import { AppModule } from "../src/server/app.module.js";
import { ApiExceptionFilter } from "../src/server/common/filters/api-exception.filter.js";

type NestFixture = {
  app: INestApplication;
  baseUrl: string;
};

async function createNestFixture(): Promise<NestFixture> {
  process.env.LLM_BASE_URL = "http://127.0.0.1:65000/v1";
  process.env.LLM_MODEL = "offline";
  process.env.SWAGGER_DISABLED = "false";
  process.env.DATABASE_URL = "";

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

test("Nest API serves health, OpenAPI, static UI, and run creation", async () => {
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

    const audit = await requestJson<{ events: unknown[] }>(fixture.baseUrl, "/api/audit-events?limit=100");
    assert.equal(JSON.stringify(audit).includes("DO-NOT-LEAK-NEST-E2E"), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API validates memory requests and exposes joined review queue data", async () => {
  const fixture = await createNestFixture();
  try {
    const invalidJson = await fetch(`${fixture.baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(invalidJson.status, 400);
    assert.match(await invalidJson.text(), /JSON|Unexpected|property/i);

    const emptyTitle = await fetch(`${fixture.baseUrl}/api/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "",
        summary: "summary",
        reusableProcedure: "procedure",
      }),
    });
    assert.equal(emptyTitle.status, 400);

    const invalidStatus = await fetch(`${fixture.baseUrl}/api/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Invalid status memory",
        summary: "summary",
        reusableProcedure: "procedure",
        status: "banana",
      }),
    });
    assert.equal(invalidStatus.status, 400);

    const created = await requestJson<{ memory: { id: string; title: string } }>(
      fixture.baseUrl,
      "/api/memories",
      {
        method: "POST",
        expectedStatus: 201,
        body: JSON.stringify({
          title: "Review queue memory",
          summary: "Proposed memory should be visible in review queue.",
          reusableProcedure: "Join review records back to memory records by memoryId.",
          status: "proposed",
          confidence: 0.7,
          evidence: ["nest api test"],
        }),
      },
    );
    const queue = await requestJson<{
      memories: Array<{ id: string }>;
      reviews: Array<{ memoryId: string; status: string; findings: Array<{ code: string }> }>;
    }>(fixture.baseUrl, "/api/memories/review-queue");

    assert.equal(queue.memories.some((memory) => memory.id === created.memory.id), true);
    const review = queue.reviews.find((item) => item.memoryId === created.memory.id);
    assert.ok(review);
    assert.equal(review.status, "needs_review");
    assert.equal(review.findings.some((finding) => finding.code === "missing_source"), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API no longer exposes legacy tool builder endpoints", async () => {
  const fixture = await createNestFixture();
  try {
    const buildRequest = await fetch(`${fixture.baseUrl}/api/tool-build-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Generic API smoke",
        reason: "Create an API tool. api key: NEST-RAW-SECRET-12345",
        qaCriteria: ["smoke call passes"],
      }),
    });
    assert.equal(buildRequest.status, 404);

    const investigation = await fetch(`${fixture.baseUrl}/api/tool-investigations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "trace_span",
        title: "Legacy investigation should not be accepted",
      }),
    });
    assert.equal(investigation.status, 404);

    const reworkWait = await fetch(`${fixture.baseUrl}/api/tool-rework-waits/legacy`);
    assert.equal(reworkWait.status, 404);

    const generatedModule = await fetch(`${fixture.baseUrl}/api/tools/generated-modules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "legacy.manual.generated",
        version: "0.1.0",
        description: "Should not be registered through the old public route.",
        capabilities: ["legacy"],
      }),
    });
    assert.equal(generatedModule.status, 404);
  } finally {
    await closeFixture(fixture);
  }
});

test("Nest API allows channel identities from ignored tool service events", async () => {
  const fixture = await createNestFixture();
  try {
    const created = await requestJson<{
      event: { id: string; payload?: Record<string, unknown> };
    }>(fixture.baseUrl, "/api/tool-service-events", {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({
        toolName: "generated.telegram.family-bot",
        direction: "inbound",
        status: "ignored",
        summary: "Inbound event ignored because the provider identity is unknown",
        sourceUserId: "123456",
        sourceChatId: "chat-1",
        sourceMessageId: "message-1",
        payload: {
          sourceUserAliases: ["dimitrii", "@dimitrii"],
          apiKey: "CHANNEL-ALLOW-DO-NOT-LEAK",
        },
      }),
    });
    assert.equal(JSON.stringify(created).includes("CHANNEL-ALLOW-DO-NOT-LEAK"), false);

    const allowed = await requestJson<{
      identities: Array<{ provider: string; providerUserId: string; allowStatus: string }>;
    }>(fixture.baseUrl, `/api/tool-service-events/${created.event.id}/allow-identity`, {
      method: "POST",
      expectedStatus: 201,
      body: JSON.stringify({}),
    });
    assert.deepEqual(
      allowed.identities.map((identity) => identity.providerUserId).sort(),
      ["123456", "@dimitrii", "dimitrii"],
    );
    assert.equal(
      allowed.identities.every(
        (identity) =>
          identity.provider === "generated.telegram.family-bot" &&
          identity.allowStatus === "allowed",
      ),
      true,
    );

    const users = await requestJson<{
      users: Array<{ id: string; identities: Array<{ provider: string; providerUserId: string }> }>;
    }>(fixture.baseUrl, "/api/users");
    const admin = users.users.find((user) => user.id === "user-admin");
    assert.ok(admin);
    assert.deepEqual(
      admin.identities
        .filter((identity) => identity.provider === "generated.telegram.family-bot")
        .map((identity) => identity.providerUserId)
        .sort(),
      ["123456", "@dimitrii", "dimitrii"],
    );

    const audit = await requestJson<{ events: unknown[] }>(fixture.baseUrl, "/api/audit-events?limit=80");
    assert.equal(JSON.stringify(audit).includes("CHANNEL-ALLOW-DO-NOT-LEAK"), false);
    assert.equal(JSON.stringify(audit).includes("channel_identity.created"), true);
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

    const claim = await requestJson<{
      item: { id: string; status: string; metadata: Record<string, unknown>; workKey: string };
      decision: { status: string; storeDecision: string; reason: string };
      reusableEvidence: unknown[];
    }>(
      fixture.baseUrl,
      "/api/work-ledger/claim",
      {
        method: "POST",
        expectedStatus: 201,
        body: JSON.stringify({
          runId: runCreated.run.id,
          threadId: runCreated.run.threadId,
          ownerSpanId: "span-nest-claim",
          kind: "api_call",
          workKeyParts: {
            apiProvider: "example",
            endpoint: "/risk",
            method: "POST",
            params: { address: "0xabc", apiKey: "WL-CLAIM-NEST-CANARY" },
          },
          taskSummary: "Claim API risk lookup",
          requestedBy: "nest-test",
          metadata: { credential: "WL-CLAIM-METADATA-CANARY" },
        }),
      },
    );
    assert.equal(claim.item.status, "claimed");
    assert.equal(claim.decision.status, "created_new");
    assert.equal(claim.item.metadata.credential, "[redacted]");
    assert.equal(claim.item.workKey.includes("WL-CLAIM-NEST-CANARY"), false);

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
    assert.equal(auditJson.includes("WL-CLAIM-NEST-CANARY"), false);
    assert.equal(auditJson.includes("WL-CLAIM-METADATA-CANARY"), false);
    assert.equal(auditJson.includes("EV-NEST-E2E-CANARY"), false);
    assert.equal(auditJson.includes("RETRO-NEST-E2E-CANARY"), false);
  } finally {
    await closeFixture(fixture);
  }
});
