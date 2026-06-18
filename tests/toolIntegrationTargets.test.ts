import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createToolPackageV1 } from "../src/tools/toolCreationV1.js";
import { inferOpenApiIntegrationContract } from "../src/tools/toolImplementationDiscoveryOpenApi.js";

test("OpenAPI discovery keeps multiple API servers as generic targets", () => {
  const contract = inferOpenApiIntegrationContract(JSON.stringify({
    openapi: "3.0.0",
    servers: [
      { url: "https://alpha.example.test/api", description: "Alpha environment" },
      { url: "https://beta.example.test/api", description: "Beta environment" },
    ],
    paths: {
      "/status": {
        get: {
          operationId: "getStatus",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }));

  assert.equal(contract?.baseUrl, "https://alpha.example.test/api");
  assert.deepEqual(contract?.targets?.map((target) => target.baseUrl), [
    "https://alpha.example.test/api",
    "https://beta.example.test/api",
  ]);
  assert.ok(contract?.targets?.some((target) => target.aliases?.includes("beta")));
  assert.ok(contract?.targets?.some((target) => target.aliases?.includes("alpha")));
  assert.ok(contract?.operations[0]?.inputSchema?.properties?.target);
});

test("OpenAPI discovery finds JSON specs inside inherited mixed documentation", () => {
  const contract = inferOpenApiIntegrationContract([
    "# Inherited package docs",
    "Existing tool context before the new uploaded API spec.",
    JSON.stringify({
      openapi: "3.1.0",
      servers: [
        { url: "https://first.example.test/api", description: "First target" },
        { url: "https://second.example.test/api", description: "Second target" },
      ],
      paths: {
        "/items/{id}": {
          get: {
            operationId: "getItem",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
    "Operator notes after the spec.",
  ].join("\n\n"));

  assert.equal(contract?.baseUrl, "https://first.example.test/api");
  assert.deepEqual(contract?.targets?.map((target) => target.id), ["first-target", "second-target"]);
});

test("OpenAPI discovery expands server variables into concrete generic targets", () => {
  const contract = inferOpenApiIntegrationContract([
    "# Tool context wrapper",
    "kind: openapi",
    "",
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://common.example.test/essential-api-{chain}",
    "    variables:",
    "      chain:",
    "        default: polygon",
    "        enum:",
    "          - polygon",
    "          - arb",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      operationId: getEssentialAddressRisk",
    "      parameters:",
    "        - name: address",
    "          in: path",
    "          required: true",
    "          schema: { type: string }",
    "      responses:",
    "        '200': { description: ok }",
  ].join("\n"));

  assert.equal(contract?.baseUrl, "https://common.example.test/essential-api-polygon");
  assert.deepEqual(contract?.targets?.map((target) => target.baseUrl), [
    "https://common.example.test/essential-api-polygon",
    "https://common.example.test/essential-api-arb",
  ]);
  assert.ok(contract?.targets?.some((target) => target.aliases?.includes("arb")));
});

test("OpenAPI discovery handles nested YAML lists before paths", () => {
  const contract = inferOpenApiIntegrationContract([
    "openapi: 3.0.3",
    "info:",
    "  title: Essential API",
    "  description: |",
    "    Supported chains:",
    "    - polygon",
    "    - arbitrum",
    "servers:",
    "  - url: https://common.example.test/essential-api-{chain}",
    "    variables:",
    "      chain:",
    "        default: polygon",
    "        enum:",
    "          - polygon",
    "          - arb",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      tags:",
    "        - Essential Support",
    "      parameters:",
    "        - name: address",
    "          in: path",
    "          required: true",
    "          schema:",
    "            type: string",
    "      responses:",
    "        '200':",
    "          description: ok",
  ].join("\n"));

  assert.deepEqual(contract?.targets?.map((target) => target.baseUrl), [
    "https://common.example.test/essential-api-polygon",
    "https://common.example.test/essential-api-arb",
  ]);
  assert.equal(contract?.operations[0]?.path, "/report/address/{address}");
});

test("OpenAPI discovery enriches enum target aliases from matching human descriptions", () => {
  const contract = inferOpenApiIntegrationContract([
    "openapi: 3.0.3",
    "info:",
    "  title: Essential API",
    "  description: |",
    "    Essential chains (Polygon, GLMR, Arbitrum).",
    "servers:",
    "  - url: https://common.example.test/essential-api-{chain}",
    "    variables:",
    "      chain:",
    "        default: polygon",
    "        enum:",
    "          - polygon",
    "          - glmr",
    "          - arb",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      responses:",
    "        '200': { description: ok }",
  ].join("\n"));

  const arb = contract?.targets?.find((target) => target.baseUrl.endsWith("/essential-api-arb"));
  assert.ok(arb?.aliases?.includes("arb"));
  assert.ok(arb?.aliases?.includes("arbitrum"));
});

test("OpenAPI discovery merges multiple uploaded YAML specs from tool context", () => {
  const contract = inferOpenApiIntegrationContract([
    "# Tool context item: advanced.yaml",
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://{chain}.example.test/api",
    "    variables:",
    "      chain:",
    "        default: eth",
    "        enum: [eth, bnb]",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      operationId: getAddressReport",
    "      parameters:",
    "        - name: address",
    "          in: path",
    "          required: true",
    "          schema: { type: string }",
    "      responses:",
    "        '200': { description: ok }",
    "",
    "---",
    "",
    "# Tool context item: essential.yaml",
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://common.example.test/essential-api-{chain}",
    "    variables:",
    "      chain:",
    "        default: polygon",
    "        enum: [polygon, arb]",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      operationId: getEssentialAddressReport",
    "      parameters:",
    "        - name: address",
    "          in: path",
    "          required: true",
    "          schema: { type: string }",
    "      responses:",
    "        '200': { description: ok }",
  ].join("\n"));

  assert.deepEqual(contract?.targets?.map((target) => target.baseUrl), [
    "https://eth.example.test/api",
    "https://bnb.example.test/api",
    "https://common.example.test/essential-api-polygon",
    "https://common.example.test/essential-api-arb",
  ]);
});

test("OpenAPI discovery splits adjacent tool-context YAML specs without delimiters", () => {
  const contract = inferOpenApiIntegrationContract([
    "# Tool context: essential.yaml",
    "kind: openapi",
    "",
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://common.example.test/essential-api-{chain}",
    "    variables:",
    "      chain:",
    "        default: polygon",
    "        enum: [polygon, arb]",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      responses:",
    "        '200': { description: ok }",
    "",
    "# Tool context: advanced.yaml",
    "kind: openapi",
    "",
    "openapi: 3.0.3",
    "servers:",
    "  - url: https://{chain}.example.test/api",
    "    variables:",
    "      chain:",
    "        default: eth",
    "        enum: [eth]",
    "paths:",
    "  /report/address/{address}:",
    "    get:",
    "      responses:",
    "        '200': { description: ok }",
  ].join("\n"));

  assert.deepEqual(contract?.targets?.map((target) => target.baseUrl), [
    "https://common.example.test/essential-api-polygon",
    "https://common.example.test/essential-api-arb",
    "https://eth.example.test/api",
  ]);
});

test("generated HTTP API tools select targets without domain-specific fields", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-target-api-"));
  const alpha = createJsonServer("alpha");
  const beta = createJsonServer("beta");
  await Promise.all([listen(alpha), listen(beta)]);
  const alphaAddress = alpha.address();
  const betaAddress = beta.address();
  assert.ok(alphaAddress && typeof alphaAddress === "object");
  assert.ok(betaAddress && typeof betaAddress === "object");
  const alphaUrl = `http://127.0.0.1:${alphaAddress.port}`;
  const betaUrl = `http://127.0.0.1:${betaAddress.port}`;

  try {
    const created = await createToolPackageV1({
      name: "targeted.status.api",
      request: "Create a generic API client with selectable API targets.",
      kind: "http-json",
      capabilities: ["api-client", "target-selection"],
      integrationContract: {
        schemaVersion: "agentic.tool-integration.v1",
        mode: "run-on-demand",
        protocol: "http-api",
        baseUrl: alphaUrl,
        targets: [
          { id: "alpha", baseUrl: alphaUrl, aliases: ["primary"] },
          { id: "beta", baseUrl: betaUrl, aliases: ["secondary"] },
        ],
        auth: { type: "none" },
        operations: [{
          name: "getStatus",
          direction: "query",
          method: "GET",
          path: "/status",
          inputSchema: {
            type: "object",
            properties: { query: { type: "object", properties: { fail: { type: "string" } } } },
          },
        }],
        callbackStrategy: "none",
      },
      behaviorExamples: [{
        title: "Call beta target",
        input: { operationId: "getStatus", target: "secondary" },
        expectedOk: true,
        expectedContentIncludes: "beta",
        expectedDataPath: "response.target",
        expectedDataEquals: "beta",
      }],
    }, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true);
    const moduleUrl = pathToFileURL(join(projectRoot, "tools", created.workspace.packageRef, "dist/index.js")).href;
    const imported = await import(`${moduleUrl}?targets=${Date.now()}`) as {
      tool: { run(input: Record<string, unknown>): Promise<{ ok: boolean; data?: any; content: string }> };
    };
    const result = await imported.tool.run({ operationId: "getStatus", target: "beta" });
    assert.equal(result.ok, true);
    assert.equal(result.data?.response?.target, "beta");
    assert.equal(result.data?.request?.targetRequested, "beta");
    assert.equal(result.data?.request?.target, "beta");
    assert.equal(result.data?.request?.operationId, "getStatus");
    assert.equal(result.data?.request?.method, "GET");
    assert.match(result.content, /beta/);

    const inferred = await imported.tool.run({ target: "secondary" });
    assert.equal(inferred.ok, true);
    assert.equal(inferred.data?.request?.operationId, "getStatus");
    assert.equal(inferred.data?.request?.target, "beta");

    const redacted = await imported.tool.run({
      operationId: "getStatus",
      target: "beta",
      query: { apiKey: "super-secret-value" },
    });
    assert.equal(redacted.ok, true);
    assert.match(redacted.data?.response?.url, /apiKey=%5Bredacted%5D|apiKey=\\[redacted\\]/);
    assert.doesNotMatch(redacted.data?.response?.url, /super-secret-value/);

    const rejected = await imported.tool.run({
      operationId: "getStatus",
      target: "beta",
      query: { fail: "true" },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.data?.diagnostic, "http_provider_error");
    assert.equal(rejected.data?.providerError?.category, "input_rejected");
    assert.match(rejected.data?.providerError?.summary, /bad parameter combination/);
    assert.deepEqual(rejected.data?.request?.inputContract?.query, ["fail"]);
    assert.match(rejected.content, /HTTP API provider returned 422/);

    const serverRejected = await imported.tool.run({
      operationId: "getStatus",
      target: "beta",
      query: { fail: "server" },
    });
    assert.equal(serverRejected.ok, false);
    assert.equal(serverRejected.data?.providerError?.category, "provider_server_error");
    assert.equal(serverRejected.data?.providerError?.summary, "nested provider message");

    const unknownTarget = await imported.tool.run({ operationId: "getStatus", target: "gamma" });
    assert.equal(unknownTarget.ok, false);
    assert.match(unknownTarget.content, /unknown target: gamma/);
    assert.deepEqual(
      unknownTarget.data?.diagnostic?.availableTargets?.map((target: { id: string }) => target.id),
      ["alpha", "beta"],
    );
  } finally {
    alpha.close();
    beta.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("generated HTTP API tools infer docs-derived operations from path params and query shape", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-operation-infer-"));
  const api = createInferenceServer();
  await listen(api);
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await createToolPackageV1({
      name: "inferred.operation.api",
      request: "Create a generic API client that can infer operations from docs-derived examples.",
      kind: "http-json",
      capabilities: ["api-client", "operation-inference"],
      integrationContract: {
        schemaVersion: "agentic.tool-integration.v1",
        mode: "run-on-demand",
        protocol: "http-api",
        baseUrl,
        auth: { type: "none" },
        operations: [
          {
            name: "addressReport",
            direction: "query",
            method: "GET",
            path: "/report/address/{address}",
            inputSchema: {
              type: "object",
              properties: {
                pathParams: { type: "object", properties: { address: { type: "string" } } },
                query: {
                  type: "object",
                  properties: { direction: { type: "integer" }, "$project[totalFunds]": { type: "integer" } },
                },
              },
            },
          },
          {
            name: "addressExplorer",
            direction: "query",
            method: "GET",
            path: "/explorer/getAddressInfo/{address}",
            inputSchema: {
              type: "object",
              properties: {
                pathParams: { type: "object", properties: { address: { type: "string" } } },
              },
            },
          },
          {
            name: "transactionReport",
            direction: "query",
            method: "GET",
            path: "/report/tx_hash/{txHash}",
            inputSchema: {
              type: "object",
              properties: {
                pathParams: { type: "object", properties: { txHash: { type: "string" } } },
              },
            },
          },
          {
            name: "transactionReportSnake",
            direction: "query",
            method: "GET",
            path: "/report/tx_hash/{tx_hash}",
            inputSchema: {
              type: "object",
              properties: {
                pathParams: { type: "object", properties: { tx_hash: { type: "string" } } },
                query: {
                  type: "object",
                  properties: { direction: { type: "integer" }, "$project[totalFunds]": { type: "integer" } },
                },
              },
            },
          },
        ],
      },
      behaviorExamples: [{
        title: "Infer address report",
        input: {
          baseUrl,
          pathParams: { address: "0xabc" },
          query: { direction: 0, "$project[totalFunds]": 0 },
        },
        expectedOk: true,
        expectedDataPath: "request.operationId",
        expectedDataEquals: "addressReport",
      }],
    }, {
      projectRoot,
      linkNodeModulesFrom: process.cwd(),
      runBuild: true,
      runTests: true,
    });

    assert.equal(created.qa.ok, true);
    const moduleUrl = pathToFileURL(join(projectRoot, "tools", created.workspace.packageRef, "dist/index.js")).href;
    const imported = await import(`${moduleUrl}?infer=${Date.now()}`) as {
      tool: { run(input: Record<string, unknown>): Promise<{ ok: boolean; data?: any; content: string }> };
    };
    const tx = await imported.tool.run({
      baseUrl,
      pathParams: { tx_hash: "0xhash" },
      query: { direction: 0, "$project[totalFunds]": 0 },
    });
    assert.equal(tx.ok, true);
    assert.equal(tx.data?.request?.operationId, "transactionReportSnake");
    assert.deepEqual(tx.data?.request?.inputContract?.query, ["direction", "$project[totalFunds]"]);

    const unknown = await imported.tool.run({ operationId: "missingOperation", baseUrl });
    assert.equal(unknown.ok, false);
    assert.match(unknown.content, /unknown operationId/);
    assert.deepEqual(
      unknown.data?.diagnostic?.availableOperations?.map((operation: { operationId: string }) => operation.operationId),
      ["addressReport", "addressExplorer", "transactionReport", "transactionReportSnake"],
    );
  } finally {
    api.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createJsonServer(name: string) {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/status")) {
      if (request.url.includes("fail=true")) {
        response.statusCode = 422;
        response.end(JSON.stringify({ error: { code: "bad_input", message: "bad parameter combination" } }));
        return;
      }
      if (request.url.includes("fail=server")) {
        response.statusCode = 500;
        response.end(JSON.stringify({ code: 500, data: { message: "nested provider message" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, target: name }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
}

function createInferenceServer() {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
