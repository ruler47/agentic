import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildToolBuilderPlan } from "../src/tools/toolBuilderAgent.js";
import { parseAuthoredPackageJson } from "../src/tools/toolBuilderPackageAuthor.js";
import { createToolPackageV1 } from "../src/tools/toolCreationV1.js";
import { discoverToolImplementation } from "../src/tools/toolImplementationDiscovery.js";

test("Tool Creation V1 builds an integration-contract HTTP API client", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-api-client-"));
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/widgets") {
      response.end(JSON.stringify({ id: "widget-1", name: "Alpha" }));
      return;
    }
    if (request.method === "GET" && request.url === "/widgets/widget-1") {
      response.end(JSON.stringify({ id: "widget-1", name: "Alpha" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const created = await createToolPackageV1({
      name: "widgets.api",
      request: "Create a widget API client from docs.",
      kind: "http-json",
      capabilities: ["api-client", "widgets"],
      integrationContract: {
        schemaVersion: "agentic.tool-integration.v1",
        mode: "run-on-demand",
        protocol: "http-api",
        auth: { type: "none" },
        operations: [
          { name: "createWidget", direction: "mutation", method: "POST", path: "/widgets" },
          {
            name: "getWidget",
            direction: "query",
            method: "GET",
            path: "/widgets/{id}",
            inputSchema: {
              type: "object",
              properties: {
                operationId: { type: "string" },
                pathParams: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              },
            },
          },
        ],
        callbackStrategy: "none",
      },
      behaviorExamples: [
        {
          title: "Create then read widget",
          steps: [
            {
              input: {
                operationId: "createWidget",
                baseUrl,
                body: { name: "Alpha" },
              },
              saveAs: "created",
              expectedOk: true,
              expectedDataPath: "id",
              expectedDataEquals: "widget-1",
            },
            {
              input: {
                operationId: "getWidget",
                baseUrl,
                pathParams: { id: "{{created.data.id}}" },
              },
              expectedOk: true,
              expectedContentIncludes: "Alpha",
            },
          ],
        },
      ],
    }, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true);
    assert.equal(created.workspace.manifest.integration?.mode, "run-on-demand");
    assert.equal(created.workspace.manifest.integration?.operations.length, 2);
    assert.ok(created.qa.checks.some((check) => check.includes("Create then read widget")));
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Tool Creation V1 HTTP API client applies integration auth from secret context", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-api-auth-"));
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers["x-api-key"] !== "runtime-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "missing api key" }));
      return;
    }
    response.end(JSON.stringify({ ok: true, tokenSeen: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const created = await createToolPackageV1({
      name: "widgets.secure",
      request: "Create a secure widget API client from docs.",
      kind: "http-json",
      capabilities: ["api-client", "secure-widgets"],
      integrationContract: {
        schemaVersion: "agentic.tool-integration.v1",
        mode: "run-on-demand",
        protocol: "http-api",
        baseUrl,
        auth: {
          type: "api-key",
          credentialLocation: "header",
          credentialName: "x-api-key",
          requiredSecretHandles: ["secret.api.api-key-auth"],
        },
        operations: [
          {
            name: "listSecureWidgets",
            direction: "query",
            method: "GET",
            path: "/secure/widgets",
          },
        ],
        callbackStrategy: "none",
      },
    }, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true);
    assert.equal(created.workspace.manifest.integration?.baseUrl, baseUrl);
    assert.deepEqual(created.workspace.manifest.requiredSecretHandles, ["secret.api.api-key-auth"]);
    const moduleUrl = pathToFileURL(join(projectRoot, "tools", created.workspace.packageRef, "dist/index.js")).href;
    const imported = await import(`${moduleUrl}?auth=${Date.now()}`) as { tool: { run(input: Record<string, unknown>, context?: unknown): Promise<{ ok: boolean; data?: unknown; content: string }> } };
    const missing = await imported.tool.run({}, { secrets: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.content, /missing required secret handle/);
    const result = await imported.tool.run(
      { headers: { "x-api-key": "bad-input-token" } },
      { secrets: { "secret.api.api-key-auth": "runtime-token" } },
    );
    assert.equal(result.ok, true);
    assert.match(result.content, /tokenSeen/);
  } finally {
    server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ToolBuilderAgent derives behavior QA from supplied cURL docs", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a status API tool.",
      documentation: [
        "```bash",
        "curl -X GET 'https://api.example.test/status' # => ok",
        "```",
      ].join("\n"),
    },
  });
  const plan = buildToolBuilderPlan({
    name: "status.api",
    request: "Create a status API tool.",
    documentation: "curl -X GET 'https://api.example.test/status' # => ok",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.protocol, "http-api");
  assert.equal(plan.input.integrationContract?.operations[0]?.method, "GET");
  assert.equal(plan.strategy.discoveryEvidence?.[1]?.provider, "curl");
  assert.deepEqual(plan.input.behaviorExamples, [
    {
      title: "cURL GET /status",
      input: {
        method: "GET",
        url: "https://api.example.test/status",
      },
      expectedOk: true,
      expectedContentIncludes: "ok",
    },
  ]);
});

test("ToolBuilderAgent derives behavior QA from HTML API docs URL", async () => {
  const documentation = `
    <html>
      <body>
        <p>Base URL: https://api.example.test</p>
        <p>Authentication: send x-api-key.</p>
        <table>
          <tr><th>Method</th><th>Endpoint</th></tr>
          <tr><td>GET</td><td>/v1/restaurants?city=Madrid&amp;partySize=2</td></tr>
        </table>
        <h3>Example response</h3>
        <pre>{ "items": [{ "id": "rest-1", "name": "Casa Azul" }] }</pre>
      </body>
    </html>
  `;
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a restaurant search API tool from docs URL.",
      docsUrl: "https://docs.example.test/restaurants",
    },
    fetchImpl: async () => new Response(documentation, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });
  const plan = buildToolBuilderPlan({
    name: "restaurants.search",
    request: "Create a restaurant search API tool from docs URL.",
    docsUrl: "https://docs.example.test/restaurants",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.baseUrl, "https://api.example.test");
  assert.equal(plan.input.integrationContract?.auth?.type, "api-key");
  assert.equal(plan.input.integrationContract?.operations[0]?.method, "GET");
  assert.equal(plan.input.integrationContract?.operations[0]?.path, "/v1/restaurants");
  assert.equal(plan.strategy.discoveryEvidence?.[1]?.provider, "html-docs");
  assert.deepEqual(plan.input.behaviorExamples?.[0], {
    title: "HTML docs GET /v1/restaurants",
    input: {
      operationId: "get_v1_restaurants",
      baseUrl: "https://api.example.test",
      query: { city: "Madrid", partySize: "2" },
      url: "https://api.example.test/v1/restaurants",
    },
    expectedOk: true,
    expectedContentIncludes: "Casa Azul",
  });
});

test("ToolBuilderAgent crawls linked HTML API docs pages before deriving QA", async () => {
  const pages: Record<string, string> = {
    "https://docs.example.test/start": `
      <html><body>
        <p>Base URL: https://api.example.test</p>
        <a href="/auth">Authentication</a>
        <a href="/reference/restaurants">Restaurant endpoint</a>
      </body></html>
    `,
    "https://docs.example.test/auth": `
      <html><body>
        <h1>Authentication</h1>
        <p>Use the x-api-key header for every request.</p>
      </body></html>
    `,
    "https://docs.example.test/reference/restaurants": `
      <html><body>
        <h1>Search restaurants</h1>
        <p>GET /v1/restaurants?city=Madrid&amp;partySize=2</p>
        <pre>{ "items": [{ "id": "rest-1", "name": "Casa Azul" }] }</pre>
      </body></html>
    `,
  };
  const fetched: string[] = [];
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a restaurant search API tool from linked docs.",
      docsUrl: "https://docs.example.test/start",
    },
    fetchImpl: async (input) => {
      const url = input instanceof URL ? input.toString() : String(input);
      fetched.push(url);
      return new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "restaurants.search",
    request: "Create a restaurant search API tool from linked docs.",
    docsUrl: "https://docs.example.test/start",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.deepEqual(fetched, [
    "https://docs.example.test/start",
    "https://docs.example.test/auth",
    "https://docs.example.test/reference/restaurants",
  ]);
  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.baseUrl, "https://api.example.test");
  assert.equal(plan.input.integrationContract?.auth?.type, "api-key");
  assert.deepEqual(plan.input.behaviorExamples?.[0]?.input?.query, { city: "Madrid", partySize: "2" });
  assert.equal(plan.input.behaviorExamples?.[0]?.expectedContentIncludes, "Casa Azul");
});

test("ToolBuilderAgent does not turn incomplete HTML endpoint docs into live QA", async () => {
  const documentation = `
    <html>
      <body>
        <p>Base URL: https://common.example.test/essential-api-</p>
        <p>GET /report/tx_hash/</p>
        <p>The path requires a blockchain ticker and transaction hash supplied by the caller.</p>
      </body>
    </html>
  `;
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create an AML API client from incomplete rendered HTML docs.",
      docsUrl: "https://docs.example.test/aml",
    },
    fetchImpl: async () => new Response(documentation, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });
  const plan = buildToolBuilderPlan({
    name: "aml.api",
    request: "Create an AML API client from incomplete rendered HTML docs.",
    docsUrl: "https://docs.example.test/aml",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.operations[0]?.path, "/report/tx_hash/");
  assert.equal(plan.input.behaviorExamples?.length ?? 0, 0);
});

test("ToolBuilderAgent does not turn HTML docs with empty query examples into live QA", async () => {
  const documentation = `
    <html>
      <body>
        <p>Base URL: https://vision.example.test/profile</p>
        <p>GET /api-labeling/entity?name=</p>
        <pre>{"status":"ok"}</pre>
      </body>
    </html>
  `;
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create an API client from HTML docs with required query values.",
      docsUrl: "https://docs.example.test/profile-api",
    },
    fetchImpl: async () => new Response(documentation, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });
  const plan = buildToolBuilderPlan({
    name: "profile.api",
    request: "Create an API client from HTML docs with required query values.",
    docsUrl: "https://docs.example.test/profile-api",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.operations[0]?.path, "/api-labeling/entity");
  assert.equal(plan.input.behaviorExamples?.length ?? 0, 0);
});

test("ToolBuilderAgent does not create live OpenAPI QA from templated server URLs", async () => {
  const openApiSpec = {
    openapi: "3.1.0",
    servers: [{ url: "https://{network}.example.test/api" }],
    paths: {
      "/report/{id}": {
        get: {
          operationId: "getReport",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  example: { totalFunds: 75 },
                },
              },
            },
          },
        },
      },
    },
  };
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create an API client from templated OpenAPI docs.",
      openApiSpec,
    },
  });
  const plan = buildToolBuilderPlan({
    name: "templated.api",
    request: "Create an API client from templated OpenAPI docs.",
    openApiSpec,
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.baseUrl, "https://{network}.example.test/api");
  assert.equal(plan.input.behaviorExamples?.length ?? 0, 0);
});

test("ToolBuilderAgent creates an always-on integration contract for messaging bots", () => {
  const plan = buildToolBuilderPlan({
    name: "telegram.bot",
    request: "Create a Telegram bot tool with a bot token that receives messages, creates Agentic runs, and sends the answer back when ready.",
    capabilities: ["telegram-bot", "always-on-messaging"],
  });

  assert.equal(plan.strategy.kind, "container-service");
  assert.equal(plan.input.kind, "service-adapter");
  assert.equal(plan.input.startupMode, "always-on");
  assert.deepEqual(plan.input.requiredSecretHandles, ["secret.telegram.bot"]);
  assert.equal(plan.input.integrationContract?.mode, "always-on-service");
  assert.equal(plan.input.integrationContract?.protocol, "messaging-bot");
  assert.equal(plan.input.integrationContract?.provider, "telegram");
  assert.ok(plan.input.integrationContract?.operations.some((operation) => operation.direction === "inbound-event"));
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("always-on service adapter")));
});

test("ToolBuilderAgent keeps channel bots on service strategy even when npm discovery finds a package", () => {
  const plan = buildToolBuilderPlan({
    name: "channel.telegram",
    request: "Create a Telegram bot channel tool that receives messages, creates Agentic runs, and sends answers back.",
    capabilities: ["telegram", "channel", "bot"],
  }, {
    discoveredCandidates: [
      {
        kind: "npm-package",
        name: "@grammyjs/types",
        packageName: "@grammyjs/types",
        versionRange: "^3.27.3",
        reason: "npm registry package candidate.",
        inspectionSummary: "Types-only package metadata inspected.",
      },
    ],
    discoveredDependencies: {
      "@grammyjs/types": "^3.27.3",
    },
  });

  assert.equal(plan.strategy.kind, "container-service");
  assert.equal(plan.input.kind, "service-adapter");
  assert.equal(plan.input.startupMode, "always-on");
  assert.equal(plan.strategy.rejectedCandidates[0]?.kind, "npm-package");
  assert.deepEqual(plan.strategy.selectedDependencies, [
    { name: "@grammyjs/types", versionRange: "^3.27.3" },
  ]);
});

test("Tool Creation V1 writes a service-adapter package with integration manifest", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-service-adapter-"));
  try {
    const plan = buildToolBuilderPlan({
      name: "telegram.bot",
      request: "Create a Telegram bot tool with a bot token that receives messages, creates Agentic runs, and sends the answer back when ready.",
      capabilities: ["telegram-bot", "always-on-messaging"],
    });
    const created = await createToolPackageV1(plan.input, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true);
    assert.equal(created.workspace.manifest.startupMode, "always-on");
    assert.equal(created.workspace.manifest.integration?.mode, "always-on-service");
    assert.deepEqual(created.workspace.manifest.requiredSecretHandles, ["secret.telegram.bot"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Tool Creation V1 writes a browser-operate package with prepare-mode contract", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-browser-operate-"));
  try {
    const plan = buildToolBuilderPlan({
      name: "browser.operate",
      request: "Create a browser operate tool that navigates, fills forms, clicks safe controls, extracts text, captures screenshots, and stops before final booking/payment commit.",
      capabilities: ["browser-operate", "browser-automation"],
    });
    const created = await createToolPackageV1(plan.input, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.input.kind, "browser-operate");
    assert.deepEqual(created.input.dependencies, { "playwright-core": "^1.56.1" });
    const inputSchema = created.workspace.manifest.inputSchema;
    assert.ok(inputSchema);
    assert.ok((inputSchema.properties as Record<string, unknown>).commands);
    assert.ok((inputSchema.properties as Record<string, unknown>).prepareOnly);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Tool Creation V1 writes an external-action-prepare package as generated capability", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-action-prepare-"));
  try {
    const plan = buildToolBuilderPlan({
      name: "external.action.prepare",
      request: "Create an external-action-prepare tool that safely prepares external action proposals, extracts forms and links, captures proof screenshots, and stops before final submit/commit.",
    });
    const created = await createToolPackageV1(plan.input, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.input.kind, "external-action-prepare");
    assert.ok(created.workspace.manifest.capabilities.includes("external-action-prepare"));
    assert.ok(created.workspace.manifest.capabilities.includes("browser-form-schema"));
    assert.deepEqual(created.input.dependencies, { "playwright-core": "^1.56.1" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Tool Creation V1 writes an external-action commit package with safe fixture behavior", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-action-commit-"));
  try {
    const plan = buildToolBuilderPlan({
      name: "external.action.reservation.commit",
      request: "Build a commit executor for approved external action reservation proposals.",
      capabilities: ["external-action-commit", "external-action-commit-reservation"],
    });
    const created = await createToolPackageV1(plan.input, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true, JSON.stringify(created.qa, null, 2));
    assert.equal(created.input.kind, "external-action-commit");
    assert.ok(created.workspace.manifest.capabilities.includes("external-action-commit"));
    const moduleUrl = pathToFileURL(join(projectRoot, "tools", created.workspace.packageRef, "dist/index.js")).href;
    const imported = await import(`${moduleUrl}?t=${Date.now()}`);
    const blocked = await imported.tool.run({
      proposalId: "proposal-1",
      actionType: "reservation",
      proposedAction: { partySize: 2 },
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.content, /missing_requirements/);

    const committed = await imported.tool.run({
      proposalId: "proposal-1",
      actionType: "reservation",
      proposedAction: { partySize: 2 },
      preparedSession: { currentUrl: "https://example.com/reserve" },
      artifactIds: ["artifact-1"],
      operatorInput: { fixtureConfirmation: "fixture-confirmed-1" },
    });
    assert.equal(committed.ok, true);
    assert.equal(committed.data.confirmationId, "fixture-confirmed-1");
    assert.equal(committed.data.preparedUrl, "https://example.com/reserve");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Tool Creation V1 repairs always-on candidates that miss startService", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-service-repair-"));
  try {
    const created = await createToolPackageV1({
      name: "service.repair",
      version: "0.1.0",
      kind: "echo",
      startupMode: "always-on",
      request: "Create an always-on integration service.",
    }, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
      qaRepairAttempts: 2,
    });

    assert.equal(created.qa.ok, true);
    assert.equal(created.input.kind, "service-adapter");
    assert.equal(created.workspace.manifest.startupMode, "always-on");
    assert.ok(created.qa.checks.some((check) => /QA repair scheduled/i.test(check)));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("parseAuthoredPackageJson accepts a complete guarded package snapshot", () => {
  const parsed = parseAuthoredPackageJson(JSON.stringify({
    readmeMarkdown: "# Demo\n",
    dockerfile: "FROM node:22-alpine\n",
    behaviorExamples: [
      {
        title: "API criterion from docs",
        input: { url: "https://example.com" },
        expectedOk: true,
        expectedContentIncludes: "Example Domain",
      },
    ],
    files: [
      { path: "index.ts", content: "export { tool } from \"./src/tools/generated/demoTool.js\";\n" },
      { path: "runtime/server.ts", content: "export {};\n" },
      { path: "src/tools/tool.ts", content: "export type Tool = { run(input: Record<string, unknown>): unknown };\n" },
      { path: "src/tools/generated/demoTool.ts", content: "export const tool = { run: () => ({ ok: true, content: \"ok\" }) };\n" },
      { path: "tests/generated/demoTool.test.ts", content: "import test from \"node:test\";\ntest(\"ok\", () => {});\n" },
    ],
  }));

  assert.equal(parsed.files.length, 5);
  assert.equal(parsed.readmeMarkdown, "# Demo\n");
  assert.deepEqual(parsed.behaviorExamples, [
    {
      title: "API criterion from docs",
      input: { url: "https://example.com" },
      expectedOk: true,
      expectedContentIncludes: "Example Domain",
    },
  ]);
});

test("parseAuthoredPackageJson accepts multi-step behavior scenarios", () => {
  const parsed = parseAuthoredPackageJson(JSON.stringify({
    behaviorExamples: [
      {
        title: "Create then read",
        steps: [
          {
            title: "Create record",
            input: { action: "create", value: "alpha" },
            saveAs: "created",
            expectedDataPath: "id",
            expectedDataIncludes: "item-",
          },
          {
            title: "Read record",
            input: { action: "read", id: "{{created.data.id}}" },
            expectedContent: "alpha",
            expectedDataPath: "value",
            expectedDataEquals: "alpha",
          },
        ],
      },
    ],
    files: [
      { path: "index.ts", content: "export { tool } from \"./src/tools/generated/demoTool.js\";\n" },
      { path: "runtime/server.ts", content: "export {};\n" },
      { path: "src/tools/tool.ts", content: "export type Tool = { run(input: Record<string, unknown>): unknown };\n" },
      { path: "src/tools/generated/demoTool.ts", content: "export const tool = { run: () => ({ ok: true, content: \"ok\" }) };\n" },
      { path: "tests/generated/demoTool.test.ts", content: "import test from \"node:test\";\ntest(\"ok\", () => {});\n" },
    ],
  }));

  assert.deepEqual(parsed.behaviorExamples, [
    {
      title: "Create then read",
      steps: [
        {
          title: "Create record",
          input: { action: "create", value: "alpha" },
          saveAs: "created",
          expectedDataPath: "id",
          expectedDataIncludes: "item-",
        },
        {
          title: "Read record",
          input: { action: "read", id: "{{created.data.id}}" },
          expectedContent: "alpha",
          expectedDataPath: "value",
          expectedDataEquals: "alpha",
        },
      ],
    },
  ]);
});

test("parseAuthoredPackageJson rejects unsafe package paths", () => {
  assert.throws(
    () => parseAuthoredPackageJson(JSON.stringify({
      files: [
        { path: "index.ts", content: "export {};\n" },
        { path: "../escape.ts", content: "export {};\n" },
      ],
    })),
    /Unsafe authored package path/,
  );
});
