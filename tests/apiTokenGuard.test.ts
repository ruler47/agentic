import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { json } from "express";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";

import { AppModule } from "../src/server/app.module.js";

type Fixture = { app: INestApplication; baseUrl: string };

async function createFixture(token: string | undefined): Promise<Fixture> {
  process.env.TOOL_BUILD_WORKER = "disabled";
  process.env.LLM_BASE_URL = "http://127.0.0.1:65000/v1";
  process.env.LLM_MODEL = "offline";
  process.env.DATABASE_URL = "";
  process.env.BUILTIN_TOOLS = "disabled";
  if (token === undefined) delete process.env.AGENTIC_API_TOKEN;
  else process.env.AGENTIC_API_TOKEN = token;

  const app = await NestFactory.create(AppModule, { abortOnError: false, logger: false });
  app.use(json());
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("with AGENTIC_API_TOKEN set the API requires the token", async () => {
  const fixture = await createFixture("secret-test-token");
  try {
    const denied = await fetch(`${fixture.baseUrl}/api/runs`);
    assert.equal(denied.status, 401);

    const bearer = await fetch(`${fixture.baseUrl}/api/runs`, {
      headers: { authorization: "Bearer secret-test-token" },
    });
    assert.equal(bearer.status, 200);

    const header = await fetch(`${fixture.baseUrl}/api/runs`, {
      headers: { "x-agentic-token": "secret-test-token" },
    });
    assert.equal(header.status, 200);

    const query = await fetch(`${fixture.baseUrl}/api/runs?token=secret-test-token`);
    assert.equal(query.status, 200);

    const wrong = await fetch(`${fixture.baseUrl}/api/runs`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);

    // Exemptions: health probes and the local browser fixture pages.
    const health = await fetch(`${fixture.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const fixturePage = await fetch(`${fixture.baseUrl}/api/fixtures/external-actions/appointment`);
    assert.equal(fixturePage.status, 200);

    // Tool callbacks carry their own HMAC tokens — the shared-token guard
    // must not intercept them (401 from the guard would mask the HMAC
    // layer; an invalid HMAC is its own 401/403 from that controller).
    const callback = await fetch(`${fixture.baseUrl}/api/tools/callbacks/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(callback.status, 404);
    const callbackBody = await callback.text();
    assert.ok(!callbackBody.includes("API token required"), `guard must not gate callbacks: ${callbackBody}`);
  } finally {
    await fixture.app.close();
    delete process.env.AGENTIC_API_TOKEN;
  }
});

test("without AGENTIC_API_TOKEN the API stays open (local dev)", async () => {
  const fixture = await createFixture(undefined);
  try {
    const open = await fetch(`${fixture.baseUrl}/api/runs`);
    assert.equal(open.status, 200);
  } finally {
    await fixture.app.close();
  }
});
