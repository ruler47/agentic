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

test("ToolBuilderAgent chooses external-api strategy from capability request", () => {
  const plan = buildToolBuilderPlan({
    name: "generated.api.reader",
    request: "Create a tool that fetches a JSON URL and returns the response preview.",
    capabilities: ["api-reader"],
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.kind, "http-json");
  assert.deepEqual(plan.strategy.selectedDependencies, []);
  assert.match(plan.strategy.reason, /HTTP|API|endpoint|fetch/i);
});

test("ToolBuilderAgent chooses browser screenshot package strategy from capability request", () => {
  const plan = buildToolBuilderPlan({
    name: "browser.screenshot",
    request: "Create a browser screenshot tool that opens a web page URL and returns a PNG artifact.",
    capabilities: ["browser-screenshot"],
  });

  assert.equal(plan.strategy.kind, "browser-automation");
  assert.equal(plan.input.kind, "browser-screenshot");
  assert.ok((plan.input.capabilities ?? []).includes("browser-screenshot"));
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("artifact-shaped")));
});

test("ToolBuilderAgent chooses browser operate package strategy for page interaction requests", () => {
  const plan = buildToolBuilderPlan({
    name: "browser.operate",
    request: "Create a browser operate tool that can navigate, fill forms, click safe controls, extract page text, capture screenshots, and stop before booking or payment commit.",
    capabilities: ["browser-operate", "browser-automation"],
  });

  assert.equal(plan.strategy.kind, "browser-automation");
  assert.equal(plan.input.kind, "browser-operate");
  assert.ok((plan.input.capabilities ?? []).includes("browser-operate"));
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("prepare mode")));
});

test("ToolBuilderAgent chooses web search package strategy for live search requests", () => {
  const plan = buildToolBuilderPlan({
    name: "web.search",
    request: "Create a tool that can perform web searches to retrieve real-time information, current prices, snippets, and URLs from search engine results.",
    capabilities: ["web-search", "information-retrieval"],
  });

  assert.equal(plan.strategy.kind, "web-search");
  assert.equal(plan.input.kind, "web-search");
  assert.ok((plan.input.capabilities ?? []).includes("web-search"));
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("query/limit")));
});

test("ToolBuilderAgent chooses web read package strategy for known page extraction", () => {
  const plan = buildToolBuilderPlan({
    name: "web.read",
    request: "Create a tool that reads a known web page URL, extracts article text, title, and links for deeper research after search.",
    capabilities: ["web-read", "web-extract", "information-retrieval"],
  });

  assert.equal(plan.strategy.kind, "web-read");
  assert.equal(plan.input.kind, "web-read");
  assert.ok((plan.input.capabilities ?? []).includes("web-extract"));
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("known source URL")));
});

test("ToolBuilderAgent treats npm dependencies as one generic implementation strategy", () => {
  const plan = buildToolBuilderPlan({
    name: "generated.text.slug",
    request: "Create a tool that turns text into a URL-safe slug.",
    dependencies: { slugify: "^1.6.6" },
  });

  assert.equal(plan.strategy.kind, "npm-package");
  assert.equal(plan.input.kind, "npm-default-function");
  assert.equal(plan.input.adapterPackageName, "slugify");
  assert.deepEqual(plan.strategy.selectedDependencies, [
    { name: "slugify", versionRange: "^1.6.6" },
  ]);
  assert.equal(plan.strategy.adapterContract?.importStyle, "default");
  assert.ok(plan.strategy.implementationNotes.some((note) => note.includes("Adapter contract")));
});

test("ToolBuilderAgent infers behavior examples from original text-transform task", () => {
  const plan = buildToolBuilderPlan({
    name: "text.camelcase",
    request: "Create a tool that uses the camelcase npm package to convert text to camelCase.",
    sourceTask: 'Преобразуй строку "hello candidate builder 2026" в camelCase.',
    capabilities: ["text-transform", "camelcase"],
    dependencies: { camelcase: "latest" },
  });

  assert.equal(plan.strategy.kind, "npm-package");
  assert.equal(plan.input.kind, "npm-default-function");
  assert.deepEqual(plan.input.behaviorExamples, [
    {
      title: "camelCase transform from original task",
      input: { text: "hello candidate builder 2026", options: {} },
      expectedOk: true,
      expectedContent: "helloCandidateBuilder2026",
    },
  ]);
  assert.deepEqual(plan.strategy.behaviorExamples, plan.input.behaviorExamples);
  assert.equal(plan.strategy.confidence, "high");
});

test("ToolBuilderAgent infers behavior examples from explicit input-output text", () => {
  const plan = buildToolBuilderPlan({
    name: "text.normalize",
    request: 'Create a text normalizer. Input: { text: "  Hello  " } -> Output: "Hello"',
    dependencies: { "text-normalizer": "^1.0.0" },
  });

  assert.deepEqual(plan.input.behaviorExamples, [
    {
      title: "Request example behavior",
      input: { text: "  Hello  " },
      expectedOk: true,
      expectedContent: "Hello",
    },
  ]);
});

test("ToolBuilderAgent can use npm discovery candidates as strategy input", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a tool that turns text into a URL-safe slug.",
      discoveryMode: "npm",
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: "slugify",
                version: "1.6.6",
                description: "Slugifies a string.",
              },
              score: { final: 0.97 },
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: "slugify",
        description: "Slugifies a string.",
        readme: "import slugify from 'slugify'\nslugify('some string')",
        versions: {
          "1.6.6": { main: "slugify.js", types: "slugify.d.ts" },
        },
      }), { status: 200 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "generated.discovered.slugify",
    request: "Create a tool that turns text into a URL-safe slug.",
    discoveryMode: "npm",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "npm-package");
  assert.equal(plan.input.kind, "npm-default-function");
  assert.equal(plan.input.adapterPackageName, "slugify");
  assert.deepEqual(plan.strategy.selectedDependencies, [
    { name: "slugify", versionRange: "^1.6.6" },
  ]);
  assert.equal(plan.strategy.discoveryEvidence?.[0]?.provider, "npm-registry");
  assert.equal(plan.strategy.discoveryEvidence?.[1]?.provider, "npm-package-metadata");
  assert.match(plan.strategy.candidates[0]?.inspectionSummary ?? "", /metadata inspected/);
  assert.deepEqual(plan.strategy.adapterContract, {
    packageName: "slugify",
    importStyle: "default",
    inputMode: "text-options",
    evidence: "README imports default slugify from slugify and calls it as a function.",
  });
  assert.deepEqual(plan.input.adapterContract, plan.strategy.adapterContract);
  assert.deepEqual(plan.strategy.behaviorExamples, [
    {
      title: "URL-safe slug transform",
      input: { text: "Hello Discovery Loop!", options: { lower: true } },
      expectedOk: true,
      expectedContent: "hello-discovery-loop!",
    },
  ]);
});

test("ToolBuilderAgent records named npm adapter contracts from README usage", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a tool that parses CSV text.",
      discoveryMode: "npm",
      discoveryQuery: "csv parser",
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: "csv-tools",
                version: "2.0.0",
                description: "CSV helpers.",
              },
              score: { final: 0.9 },
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: "csv-tools",
        description: "CSV helpers.",
        readme: "import { parseCsv } from 'csv-tools'\nparseCsv('a,b')",
        versions: {
          "2.0.0": { exports: { ".": "./index.js" } },
        },
      }), { status: 200 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "generated.discovered.csv",
    request: "Create a tool that parses CSV text.",
    discoveryMode: "npm",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "npm-package");
  assert.deepEqual(plan.strategy.adapterContract, {
    packageName: "csv-tools",
    importStyle: "named",
    exportName: "parseCsv",
    inputMode: "text-options",
    evidence: "README imports named export parseCsv from csv-tools and calls it as a function.",
  });
  assert.match(plan.strategy.discoveryEvidence?.[1]?.summary ?? "", /Adapter contract: call named export parseCsv/);
});

test("ToolBuilderAgent prefers direct package calls over helper members in README usage", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a tool that turns text into a URL-safe slug.",
      discoveryMode: "npm",
      discoveryQuery: "slugify",
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: "slugify",
                version: "1.6.9",
                description: "Slugifies a string.",
              },
              score: { final: 0.97 },
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: "slugify",
        description: "Slugifies a string.",
        readme: [
          "const slugify = require('slugify')",
          "slugify('some string')",
          "slugify.extend({})",
        ].join("\n"),
        versions: {
          "1.6.9": { main: "slugify.js", types: "slugify.d.ts" },
        },
      }), { status: 200 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "generated.discovered.slugify",
    request: "Create a tool that turns text into a URL-safe slug.",
    discoveryMode: "npm",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.deepEqual(plan.strategy.adapterContract, {
    packageName: "slugify",
    importStyle: "default",
    inputMode: "text-options",
    evidence: "README requires slugify into slugify and calls it as a function.",
  });
  assert.match(plan.strategy.discoveryEvidence?.[1]?.summary ?? "", /Adapter contract: call default export/);
});

test("ToolBuilderAgent derives object input schemas from README package calls", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a tool that converts values between units.",
      discoveryMode: "npm",
      discoveryQuery: "unit converter",
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: "unit-tools",
                version: "1.0.0",
                description: "Unit conversion helpers.",
              },
              score: { final: 0.91 },
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: "unit-tools",
        description: "Unit conversion helpers.",
        readme: "import { convert } from 'unit-tools'\nconvert({ value: 2, from: 'm', to: 'cm' })",
        versions: {
          "1.0.0": { exports: { ".": "./index.js" } },
        },
      }), { status: 200 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "generated.discovered.unit",
    request: "Create a tool that converts values between units.",
    discoveryMode: "npm",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "npm-package");
  assert.equal(plan.strategy.adapterContract?.inputMode, "object");
  assert.deepEqual(plan.strategy.adapterContract?.inputSchema?.required, ["value", "from", "to"]);
  assert.deepEqual(plan.strategy.adapterContract?.inputExample, { value: 2, from: "m", to: "cm" });
  assert.match(plan.strategy.adapterContract?.evidence ?? "", /object input/);
  assert.deepEqual(plan.input.adapterContract, plan.strategy.adapterContract);
});

test("ToolBuilderAgent turns README package examples into behavior QA", async () => {
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a tool that converts values between units.",
      discoveryMode: "npm",
      discoveryQuery: "unit converter",
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("/-/v1/search")) {
        return new Response(JSON.stringify({
          objects: [
            {
              package: {
                name: "unit-tools",
                version: "1.0.0",
                description: "Unit conversion helpers.",
              },
              score: { final: 0.91 },
            },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: "unit-tools",
        description: "Unit conversion helpers.",
        readme: [
          "import { convert } from 'unit-tools'",
          "convert({ value: 2, from: 'm', to: 'cm' }) // 200",
        ].join("\n"),
        versions: {
          "1.0.0": { exports: { ".": "./index.js" } },
        },
      }), { status: 200 });
    },
  });
  const plan = buildToolBuilderPlan({
    name: "generated.discovered.unit",
    request: "Create a tool that converts values between units.",
    discoveryMode: "npm",
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.deepEqual(plan.strategy.behaviorExamples, [
    {
      title: "README package example",
      input: { value: 2, from: "m", to: "cm" },
      expectedOk: true,
      expectedContentIncludes: "200",
    },
  ]);
  assert.deepEqual(plan.input.behaviorExamples, plan.strategy.behaviorExamples);
  assert.match(plan.strategy.discoveryEvidence?.[1]?.summary ?? "", /README behavior examples inferred: 1/);
});

test("ToolBuilderAgent derives multi-step behavior QA from supplied OpenAPI docs", async () => {
  const openApiSpec = {
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.test" }],
    components: {
      schemas: {
        WidgetCreate: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
          },
        },
      },
    },
    paths: {
      "/widgets": {
        post: {
          operationId: "createWidget",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WidgetCreate" },
                example: { name: "Alpha" },
              },
            },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  example: { id: "widget-1", name: "Alpha" },
                },
              },
            },
          },
        },
      },
      "/widgets/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: {
          operationId: "getWidget",
          responses: {
            "200": {
              content: {
                "application/json": {
                  example: { id: "widget-1", name: "Alpha" },
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
      request: "Create a widget API tool from these docs.",
      openApiSpec,
    },
  });
  const plan = buildToolBuilderPlan({
    name: "widgets.api",
    request: "Create a widget API tool from these docs.",
    openApiSpec,
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.kind, "http-json");
  assert.equal(plan.strategy.integrationContract?.mode, "run-on-demand");
  assert.equal(plan.strategy.integrationContract?.protocol, "http-api");
  assert.equal(plan.strategy.integrationContract?.operations[0]?.name, "createWidget");
  assert.equal(plan.input.integrationContract?.operations[1]?.path, "/widgets/{id}");
  assert.equal(
    (plan.input.integrationContract?.operations[0]?.inputSchema?.properties.body as { required?: string[] } | undefined)?.required?.[0],
    "name",
  );
  assert.equal(
    ((plan.input.integrationContract?.operations[1]?.inputSchema?.properties.pathParams as { properties?: Record<string, unknown> } | undefined)?.properties?.id as { type?: string } | undefined)?.type,
    "string",
  );
  assert.equal(plan.strategy.discoveryEvidence?.[1]?.provider, "openapi");
  assert.ok(plan.input.behaviorExamples);
  assert.deepEqual(plan.input.behaviorExamples[0], {
    title: "OpenAPI scenario POST /widgets -> GET /widgets/{id}",
    steps: [
      {
        title: "Create via POST /widgets",
        input: {
          operationId: "createWidget",
          baseUrl: "https://api.example.test",
          body: { name: "Alpha" },
        },
        saveAs: "created",
        expectedOk: true,
        expectedDataPath: "id",
        expectedDataEquals: "widget-1",
      },
      {
        title: "Read via GET /widgets/{id}",
        input: {
          operationId: "getWidget",
          pathParams: { id: "{{created.data.id}}" },
          baseUrl: "https://api.example.test",
        },
        expectedOk: true,
        expectedContentIncludes: "Alpha",
      },
    ],
  });
});

test("ToolBuilderAgent derives OpenAPI auth into secret handles", async () => {
  const openApiSpec = {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.test" }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },
    },
    paths: {
      "/secure/widgets": {
        get: {
          operationId: "listSecureWidgets",
          responses: {
            "200": {
              content: {
                "application/json": {
                  example: { items: [{ id: "secure-widget-1" }] },
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
      request: "Create a secure widget API tool from these docs.",
      openApiSpec,
    },
  });
  const plan = buildToolBuilderPlan({
    name: "widgets.secure",
    request: "Create a secure widget API tool from these docs.",
    openApiSpec,
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.input.integrationContract?.auth?.type, "api-key");
  assert.equal(plan.input.integrationContract?.auth?.credentialLocation, "header");
  assert.equal(plan.input.integrationContract?.auth?.credentialName, "x-api-key");
  assert.deepEqual(plan.input.requiredSecretHandles, ["secret.api.api-key-auth"]);
  assert.deepEqual(plan.input.integrationContract?.operations[0]?.requiredSecretHandles, ["secret.api.api-key-auth"]);
});

test("ToolBuilderAgent derives behavior QA from YAML OpenAPI schema refs", async () => {
  const documentation = `
openapi: 3.1.0
servers:
  - url: https://api.example.test
components:
  schemas:
    BookingCreate:
      type: object
      required: [restaurantId, partySize]
      properties:
        restaurantId:
          type: string
          example: rest-42
        partySize:
          type: integer
          example: 2
    Booking:
      type: object
      required: [id, restaurantId, partySize]
      properties:
        id:
          type: string
          example: booking-1
        restaurantId:
          type: string
          example: rest-42
        partySize:
          type: integer
          example: 2
paths:
  /bookings:
    post:
      operationId: createBooking
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/BookingCreate'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Booking'
  /bookings/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getBooking
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Booking'
`;
  const discovery = await discoverToolImplementation({
    rawInput: {
      request: "Create a booking API tool from YAML OpenAPI docs.",
      documentation,
    },
  });
  const plan = buildToolBuilderPlan({
    name: "booking.api",
    request: "Create a booking API tool from YAML OpenAPI docs.",
    documentation,
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.baseUrl, "https://api.example.test");
  assert.deepEqual(plan.input.behaviorExamples?.[0], {
    title: "OpenAPI scenario POST /bookings -> GET /bookings/{id}",
    steps: [
      {
        title: "Create via POST /bookings",
        input: {
          operationId: "createBooking",
          baseUrl: "https://api.example.test",
          body: { restaurantId: "rest-42", partySize: 2 },
        },
        saveAs: "created",
        expectedOk: true,
        expectedDataPath: "id",
        expectedDataEquals: "booking-1",
      },
      {
        title: "Read via GET /bookings/{id}",
        input: {
          operationId: "getBooking",
          pathParams: { id: "{{created.data.id}}" },
          baseUrl: "https://api.example.test",
        },
        expectedOk: true,
        expectedContentIncludes: "booking-1",
      },
    ],
  });
});

test("ToolBuilderAgent derives standalone OpenAPI query examples from parameter examples", async () => {
  const openApiSpec = {
    openapi: "3.1.0",
    servers: [{ url: "https://api.open-meteo.com" }],
    paths: {
      "/v1/forecast": {
        get: {
          operationId: "getForecast",
          parameters: [
            {
              name: "latitude",
              in: "query",
              required: true,
              schema: { type: "number", example: 52.52 },
            },
            {
              name: "longitude",
              in: "query",
              required: true,
              schema: { type: "number", example: 13.41 },
            },
            {
              name: "current",
              in: "query",
              required: true,
              example: "temperature_2m",
              schema: { type: "string" },
            },
            {
              name: "timezone",
              in: "query",
              required: false,
              schema: { type: "string", default: "auto" },
            },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  example: {
                    latitude: 52.52,
                    longitude: 13.41,
                    current: { temperature_2m: 21.5 },
                  },
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
      request: "Create an Open-Meteo forecast API tool.",
      openApiSpec,
    },
  });
  const plan = buildToolBuilderPlan({
    name: "weather.open-meteo",
    request: "Create an Open-Meteo forecast API tool.",
    openApiSpec,
  }, {
    discoveredCandidates: discovery.candidates,
    discoveredDependencies: discovery.dependencies,
    discoveryEvidence: discovery.evidence,
    discoveryNotes: discovery.notes,
  });

  assert.equal(plan.strategy.kind, "external-api");
  assert.equal(plan.input.integrationContract?.baseUrl, "https://api.open-meteo.com");
  assert.deepEqual(plan.input.behaviorExamples?.[0]?.input?.query, {
    latitude: 52.52,
    longitude: 13.41,
    current: "temperature_2m",
    timezone: "auto",
  });
  assert.equal(plan.input.behaviorExamples?.[0]?.expectedContentIncludes, "52.52");
});
