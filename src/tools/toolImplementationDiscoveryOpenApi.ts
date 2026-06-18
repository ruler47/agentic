import type { ToolAdapterContract, ToolBehaviorExample } from "./toolCreationStore.js";
import type {
  ToolIntegrationContract,
  ToolIntegrationOperation,
} from "./toolIntegrationContract.js";
import type { ToolSchema } from "./tool.js";
import { parseYamlOpenApiSpec } from "./toolImplementationDiscoveryOpenApiYaml.js";
import { isRecord } from "./toolImplementationDiscoveryNpmReadme.js";
import {
  firstOpenApiServerUrl,
  isConcreteLiveServerUrl,
  listOpenApiTargets,
} from "./toolImplementationDiscoveryOpenApiTargets.js";

type OpenApiSpec = {
  openapi?: unknown;
  swagger?: unknown;
  servers?: Array<{ url?: unknown; description?: unknown; variables?: unknown }>;
  security?: unknown;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
  paths?: Record<string, Record<string, unknown>>;
};

type OpenApiOperation = {
  operationId?: unknown;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
  security?: unknown;
};

type OpenApiParameter = {
  $ref?: unknown;
  name?: unknown;
  in?: unknown;
  required?: unknown;
  example?: unknown;
  examples?: unknown;
  schema?: unknown;
};

export function inferOpenApiBehaviorExamples(text: string): ToolBehaviorExample[] {
  const spec = parseOpenApiSpec(text);
  if (!spec?.paths || typeof spec.paths !== "object") return [];
  const serverUrl = firstOpenApiServerUrl(spec);
  const qaServerUrl = isConcreteLiveServerUrl(serverUrl) ? serverUrl : undefined;
  if (!qaServerUrl) return [];
  const operations = listOpenApiOperations(spec);
  const scenario = inferOpenApiCreateReadScenario(operations, qaServerUrl);
  const singleSourceOperations = scenario
    ? operations.filter(isSafeStandaloneOpenApiQaOperation)
    : operations;
  const single = singleSourceOperations
    .map((operation) => openApiOperationToBehaviorExample(operation, qaServerUrl))
    .filter((example): example is ToolBehaviorExample => Boolean(example));
  return [...(scenario ? [scenario] : []), ...single].slice(0, 5);
}

function isSafeStandaloneOpenApiQaOperation(operation: ListedOpenApiOperation): boolean {
  if (operation.method !== "GET") return false;
  return operation.parameters.every((parameter) =>
    !parameter.required ||
    !["path", "query"].includes(parameter.in) ||
    parameterExampleValue(parameter) !== undefined
  );
}

export function inferOpenApiIntegrationContract(text: string): ToolIntegrationContract | undefined {
  const spec = parseOpenApiSpec(text);
  if (!spec?.paths || typeof spec.paths !== "object") return undefined;
  const serverUrl = firstOpenApiServerUrl(spec);
  const targets = listOpenApiTargets(spec);
  const operations = listOpenApiOperations(spec);
  if (operations.length === 0) return undefined;
  const auth = inferOpenApiAuth(spec, operations) ?? { type: "none" as const };
  return {
    schemaVersion: "agentic.tool-integration.v1",
    mode: "run-on-demand",
    protocol: "http-api",
    ...(serverUrl ? { baseUrl: serverUrl } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    auth,
    operations: operations.slice(0, 20).map((operation): ToolIntegrationOperation => ({
      name: operation.operationId ?? `${operation.method.toLowerCase()}_${operation.path.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`,
      direction: operation.method === "GET" ? "query" : "mutation",
      method: operation.method,
      path: operation.path,
      requiredSecretHandles: auth.requiredSecretHandles,
      inputSchema: openApiOperationInputSchema(operation),
      outputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          content: { type: "string" },
          data: { type: "object" },
        },
      },
    })),
    callbackStrategy: "none",
    notes: [
      "Derived from supplied OpenAPI documentation.",
      auth.type === "none"
        ? "No OpenAPI security scheme was detected; operators should verify auth before live promotion."
        : "OpenAPI security scheme was converted to a secret-handle requirement; raw credential values are not copied into generated source.",
      targets.length > 1
        ? "Multiple API targets were derived from OpenAPI servers. Generated clients can select them with the generic target input."
        : "Exact API target aliases should be verified before live promotion.",
      "Exact schemas should be refined from referenced components before live promotion.",
    ],
  };
}

function inferOpenApiAuth(spec: OpenApiSpec, operations: ListedOpenApiOperation[]): ToolIntegrationContract["auth"] {
  const schemes = isRecord(spec.components?.securitySchemes) ? spec.components.securitySchemes : {};
  const referencedName = firstSecurityRequirementName(spec.security)
    ?? operations.map((operation) => firstSecurityRequirementName(operation.security)).find(Boolean);
  const schemeName = referencedName ?? Object.keys(schemes)[0];
  const rawScheme = schemeName ? schemes[schemeName] : undefined;
  if (!schemeName || !isRecord(rawScheme)) return { type: "none" };

  const type = typeof rawScheme.type === "string" ? rawScheme.type.toLowerCase() : "";
  const httpScheme = typeof rawScheme.scheme === "string" ? rawScheme.scheme.toLowerCase() : "";
  const location = typeof rawScheme.in === "string" ? rawScheme.in.toLowerCase() : "";
  const credentialName = typeof rawScheme.name === "string" ? rawScheme.name : undefined;
  const handle = `secret.api.${normalizeSecretHandleSegment(schemeName)}`;
  if (type === "apikey") {
    return {
      type: "api-key",
      credentialLocation: location === "query" ? "query" : location === "cookie" ? "cookie" : "header",
      credentialName: credentialName ?? (location === "query" ? "api_key" : "x-api-key"),
      requiredSecretHandles: [handle],
      notes: `Derived from OpenAPI apiKey security scheme ${schemeName}.`,
    };
  }
  if (type === "http" && httpScheme === "bearer") {
    return {
      type: "bearer-token",
      credentialLocation: "header",
      credentialName: "authorization",
      authorizationScheme: "Bearer",
      requiredSecretHandles: [handle],
      notes: `Derived from OpenAPI HTTP bearer security scheme ${schemeName}.`,
    };
  }
  if (type === "http" && httpScheme === "basic") {
    return {
      type: "basic",
      credentialLocation: "header",
      credentialName: "authorization",
      authorizationScheme: "Basic",
      requiredSecretHandles: [handle],
      notes: `Derived from OpenAPI HTTP basic security scheme ${schemeName}.`,
    };
  }
  if (type === "oauth2" || type === "openidconnect") {
    return {
      type: "oauth2",
      credentialLocation: "header",
      credentialName: "authorization",
      authorizationScheme: "Bearer",
      requiredSecretHandles: [handle],
      notes: `Derived from OpenAPI ${type} security scheme ${schemeName}.`,
    };
  }
  return {
    type: "custom",
    requiredSecretHandles: [handle],
    notes: `OpenAPI security scheme ${schemeName} has unsupported type ${type || "unknown"}; generated tool requires an operator-mapped secret handle before live use.`,
  };
}

function firstSecurityRequirementName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const key = Object.keys(item).find((name) => name.trim().length > 0);
    if (key) return key;
  }
  return undefined;
}

function normalizeSecretHandleSegment(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "integration";
}

function parseOpenApiSpec(text: string): OpenApiSpec | undefined {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as OpenApiSpec;
      if (parsed && typeof parsed === "object" && (parsed.openapi || parsed.swagger) && parsed.paths) return parsed;
    } catch {
      // Try the next JSON-looking candidate.
    }
  }
  return parseYamlOpenApiSpec(text) as OpenApiSpec | undefined;
}

function jsonCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:json|openapi)?\s*([\s\S]*?)```/giu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const trimmed = text.trim();
  return uniqueStrings([
    ...fenced,
    ...(trimmed.startsWith("{") && trimmed.endsWith("}") ? [trimmed] : []),
    ...embeddedJsonObjectCandidates(text),
  ]).filter((value) => value.startsWith("{") && value.endsWith("}"));
}

function embeddedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length && candidates.length < 20; index++) {
    if (text[index] !== "{") continue;
    const candidate = readJsonObjectCandidate(text, index);
    if (!candidate) continue;
    if (candidate.includes("\"openapi\"") || candidate.includes("\"swagger\"")) {
      candidates.push(candidate);
    }
    index += candidate.length - 1;
  }
  return candidates;
}

function readJsonObjectCandidate(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

type ListedOpenApiOperation = {
  method: string;
  path: string;
  operationId?: string;
  security?: unknown;
  parameters: ListedOpenApiParameter[];
  requestSchema?: unknown;
  requestExample?: Record<string, unknown>;
  responseSchema?: unknown;
  responseExample?: unknown;
};

type ListedOpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema?: unknown;
  example?: unknown;
};

function listOpenApiOperations(spec: OpenApiSpec): ListedOpenApiOperation[] {
  const out: ListedOpenApiOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    if (!rawPathItem || typeof rawPathItem !== "object" || Array.isArray(rawPathItem)) continue;
    const pathParameters = parseOpenApiParameters(rawPathItem.parameters, spec);
    for (const [method, rawOperation] of Object.entries(rawPathItem)) {
      const normalizedMethod = method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) continue;
      if (!rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)) continue;
      const operation = rawOperation as OpenApiOperation;
      const parameters = [...pathParameters, ...parseOpenApiParameters(operation.parameters, spec)];
      out.push({
        method: normalizedMethod,
        path,
        operationId: typeof operation.operationId === "string" ? operation.operationId : undefined,
        security: operation.security,
        parameters,
        requestSchema: extractOpenApiRequestSchema(operation, spec),
        requestExample: extractOpenApiRequestExample(operation, spec),
        responseSchema: extractOpenApiResponseSchema(operation, spec),
        responseExample: extractOpenApiResponseExample(operation, spec),
      });
    }
  }
  return out;
}

function openApiOperationInputSchema(operation: ListedOpenApiOperation): ToolSchema {
  const pathParams = openApiParametersObjectSchema(operation.parameters, "path");
  const query = openApiParametersObjectSchema(operation.parameters, "query");
  const properties: Record<string, unknown> = {
    operationId: { type: "string", const: operation.operationId ?? operation.method },
    target: { type: "string" },
    baseUrl: { type: "string" },
    path: { type: "string" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    maxLength: { type: "number" },
    body: operation.requestSchema ? normalizeJsonSchema(operation.requestSchema) : { type: "object" },
  };
  if (pathParams) properties.pathParams = pathParams;
  if (query) properties.query = query;
  return {
    type: "object",
    properties,
    required: ["operationId"],
  };
}

function openApiParametersObjectSchema(
  parameters: ListedOpenApiParameter[],
  location: ListedOpenApiParameter["in"],
): ToolSchema | undefined {
  const relevant = parameters.filter((parameter) => parameter.in === location);
  if (relevant.length === 0) return undefined;
  return {
    type: "object",
    properties: Object.fromEntries(
      relevant.map((parameter) => [parameter.name, normalizeJsonSchema(parameter.schema ?? { type: "string" })]),
    ),
    required: relevant.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  };
}

function parseOpenApiParameters(value: unknown, spec: OpenApiSpec): ListedOpenApiParameter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ListedOpenApiParameter[] => {
    const parameter = resolveOpenApiRef(item, spec) as OpenApiParameter | undefined;
    if (!isRecord(parameter)) return [];
    const name = typeof parameter.name === "string" ? parameter.name.trim() : "";
    const location = typeof parameter.in === "string" ? parameter.in.trim() : "";
    if (!name || !isOpenApiParameterLocation(location)) return [];
    return [{
      name,
      in: location,
      required: parameter.required === true || location === "path",
      schema: resolveOpenApiRef(parameter.schema, spec),
      example: extractOpenApiParameterExample(parameter, spec),
    }];
  });
}

function isOpenApiParameterLocation(value: string): value is ListedOpenApiParameter["in"] {
  return value === "path" || value === "query" || value === "header" || value === "cookie";
}

function extractOpenApiParameterExample(parameter: OpenApiParameter, spec: OpenApiSpec): unknown {
  if (parameter.example !== undefined) return parameter.example;
  const examples = isRecord(parameter.examples) ? parameter.examples : undefined;
  const first = examples ? Object.values(examples)[0] : undefined;
  if (isRecord(first) && first.value !== undefined) return first.value;
  const schema = resolveOpenApiRef(parameter.schema, spec);
  if (isRecord(schema)) {
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
    if (enumValues?.length) return enumValues[0];
  }
  return undefined;
}

function openApiOperationToBehaviorExample(
  operation: ListedOpenApiOperation,
  serverUrl: string | undefined,
): ToolBehaviorExample | undefined {
  const pathParams = exampleParameters(operation, "path", true);
  if (hasRequiredParameters(operation, "path") && !pathParams) return undefined;
  const query = exampleParameters(operation, "query");
  if (hasRequiredParameters(operation, "query") && !query) return undefined;
  const input: Record<string, unknown> = {
    operationId: operation.operationId,
    ...(serverUrl ? { baseUrl: serverUrl } : {}),
    ...(operation.requestExample ? { body: operation.requestExample } : {}),
    ...(pathParams ? { pathParams } : {}),
    ...(query ? { query } : {}),
  };
  if (serverUrl && operation.method === "GET" && !operation.path.includes("{")) {
    input.url = `${serverUrl}${operation.path}`;
  }
  const expected = firstUsefulScalar(operation.responseExample);
  return {
    title: `OpenAPI ${operation.method} ${operation.path}`,
    input,
    expectedOk: true,
    ...(expected !== undefined ? { expectedContentIncludes: String(expected) } : { expectedDataPath: "status" }),
  };
}

function hasRequiredParameters(
  operation: ListedOpenApiOperation,
  location: ListedOpenApiParameter["in"],
): boolean {
  return operation.parameters.some((parameter) => parameter.in === location && parameter.required);
}

function exampleParameters(
  operation: ListedOpenApiOperation,
  location: ListedOpenApiParameter["in"],
  includeResponseHints = false,
): Record<string, unknown> | undefined {
  const parameters = operation.parameters.filter((parameter) => parameter.in === location);
  if (parameters.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const parameter of parameters) {
    const value = parameterExampleValue(parameter)
      ?? (includeResponseHints ? findScalarByKey(operation.responseExample, parameter.name) : undefined)
      ?? (includeResponseHints ? findScalarByKey(operation.requestExample, parameter.name) : undefined);
    if (value === undefined) {
      if (parameter.required) return undefined;
      continue;
    }
    out[parameter.name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parameterExampleValue(parameter: ListedOpenApiParameter): unknown {
  if (parameter.example !== undefined) return parameter.example;
  const schema = isRecord(parameter.schema) ? parameter.schema : undefined;
  if (schema?.example !== undefined) return schema.example;
  if (schema?.default !== undefined) return schema.default;
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : undefined;
  return enumValues?.[0];
}

function firstUsefulScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const scalar = firstUsefulScalar(nested);
      if (scalar !== undefined) return scalar;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["name", "title", "id", "status", "message", "result", "value"]) {
    const nested = value[key];
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean") return nested;
  }
  for (const nested of Object.values(value)) {
    const scalar = firstUsefulScalar(nested);
    if (scalar !== undefined) return scalar;
  }
  return undefined;
}

function findScalarByKey(value: unknown, key: string): string | number | boolean | undefined {
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findScalarByKey(nested, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = value[key];
  if (typeof direct === "string" || typeof direct === "number" || typeof direct === "boolean") return direct;
  for (const nested of Object.values(value)) {
    const found = findScalarByKey(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function inferOpenApiCreateReadScenario(
  operations: ListedOpenApiOperation[],
  serverUrl: string | undefined,
): ToolBehaviorExample | undefined {
  const create = operations.find((operation) => operation.method === "POST" && operation.requestExample);
  if (!create) return undefined;
  const idValue = findScalarByKey(create.responseExample, "id") ?? "generated-id";
  const read = operations.find((operation) =>
    operation.method === "GET" &&
    (operation.path.includes("{id}") || operation.path.includes(":id") || /\/id\b/i.test(operation.path)),
  );
  if (!read) return undefined;
  const readPathParameterName = firstPathParameterName(read);
  const placeholderPath = read.path
    .replace(/\{id\}/g, "{{created.data.id}}")
    .replace(/:id/g, "{{created.data.id}}");
  const expected = firstUsefulScalar(read.responseExample)
    ?? firstUsefulScalar(create.requestExample)
    ?? firstUsefulScalar(create.responseExample);
  return {
    title: `OpenAPI scenario ${create.method} ${create.path} -> ${read.method} ${read.path}`,
    steps: [
      {
        title: `Create via ${create.method} ${create.path}`,
        input: {
          operationId: create.operationId,
          ...(serverUrl ? { baseUrl: serverUrl } : {}),
          ...(create.requestExample ? { body: create.requestExample } : {}),
        },
        saveAs: "created",
        expectedOk: true,
        expectedDataPath: "id",
        expectedDataEquals: idValue,
      },
      {
        title: `Read via ${read.method} ${read.path}`,
        input: {
          operationId: read.operationId,
          ...(readPathParameterName
            ? { pathParams: { [readPathParameterName]: "{{created.data.id}}" } }
            : { path: placeholderPath }),
          ...(serverUrl ? { baseUrl: serverUrl } : {}),
        },
        expectedOk: true,
        ...(expected !== undefined ? { expectedContentIncludes: String(expected) } : { expectedDataPath: "id" }),
      },
    ],
  };
}

function firstPathParameterName(operation: ListedOpenApiOperation): string | undefined {
  const declared = operation.parameters.find((parameter) => parameter.in === "path")?.name;
  if (declared) return declared;
  const match = operation.path.match(/\{([^}]+)\}|:([A-Za-z0-9_]+)/);
  return match?.[1] ?? match?.[2];
}

function extractOpenApiRequestExample(operation: OpenApiOperation, spec: OpenApiSpec): Record<string, unknown> | undefined {
  const body = resolveOpenApiRef(operation.requestBody, spec);
  const content = isRecord(body) && isRecord(body.content) ? body.content : undefined;
  const json = isRecord(content?.["application/json"]) ? content["application/json"] : undefined;
  const example = extractExampleValue(json, spec);
  return isRecord(example) ? example : undefined;
}

function extractOpenApiRequestSchema(operation: OpenApiOperation, spec: OpenApiSpec): unknown {
  const body = resolveOpenApiRef(operation.requestBody, spec);
  const content = isRecord(body) && isRecord(body.content) ? body.content : undefined;
  const json = isRecord(content?.["application/json"]) ? content["application/json"] : undefined;
  return resolveOpenApiRef(json?.schema, spec);
}

function extractOpenApiResponseExample(operation: OpenApiOperation, spec: OpenApiSpec): unknown {
  const responses = isRecord(operation.responses) ? operation.responses : undefined;
  const preferred = ["200", "201", "202", "default", ...Object.keys(responses ?? {})];
  for (const status of preferred) {
    const response = resolveOpenApiRef(responses?.[status], spec);
    const content = isRecord(response) && isRecord(response.content) ? response.content : undefined;
    const json = isRecord(content?.["application/json"]) ? content["application/json"] : undefined;
    const example = extractExampleValue(json, spec);
    if (example !== undefined) return example;
  }
  return undefined;
}

function extractOpenApiResponseSchema(operation: OpenApiOperation, spec: OpenApiSpec): unknown {
  const responses = isRecord(operation.responses) ? operation.responses : undefined;
  const preferred = ["200", "201", "202", "default", ...Object.keys(responses ?? {})];
  for (const status of preferred) {
    const response = resolveOpenApiRef(responses?.[status], spec);
    const content = isRecord(response) && isRecord(response.content) ? response.content : undefined;
    const json = isRecord(content?.["application/json"]) ? content["application/json"] : undefined;
    const schema = resolveOpenApiRef(json?.schema, spec);
    if (schema !== undefined) return schema;
  }
  return undefined;
}

function resolveOpenApiRef(value: unknown, spec: OpenApiSpec, seen = new Set<string>()): unknown {
  if (!isRecord(value)) return value;
  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (!ref?.startsWith("#/") || seen.has(ref)) return value;
  seen.add(ref);
  const target = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, spec);
  return resolveOpenApiRef(target, spec, seen);
}

function normalizeJsonSchema(value: unknown): unknown {
  if (!isRecord(value)) return { type: "object" };
  const resolved = resolveOpenApiRef(value, { paths: {} });
  if (!isRecord(resolved)) return { type: "object" };
  const out: Record<string, unknown> = {};
  for (const key of ["type", "format", "description", "enum", "items", "properties", "required", "minimum", "maximum", "minLength", "maxLength", "default", "example"]) {
    if (resolved[key] !== undefined) out[key] = normalizeNestedJsonSchema(resolved[key]);
  }
  return Object.keys(out).length > 0 ? out : { type: "object" };
}

function normalizeNestedJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNestedJsonSchema);
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string") return { description: `Unresolved schema reference ${value.$ref}` };
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "additionalProperties" && typeof nested === "boolean") {
      out[key] = nested;
      continue;
    }
    if (["type", "format", "description", "enum", "items", "properties", "required", "minimum", "maximum", "minLength", "maxLength", "default", "example"].includes(key)) {
      out[key] = normalizeNestedJsonSchema(nested);
    }
  }
  return out;
}

function extractExampleValue(container: Record<string, unknown> | undefined, spec: OpenApiSpec): unknown {
  if (!container) return undefined;
  if (container.example !== undefined) return container.example;
  const examples = isRecord(container.examples) ? container.examples : undefined;
  const first = examples ? Object.values(examples)[0] : undefined;
  if (isRecord(first) && first.value !== undefined) return first.value;
  return exampleFromSchema(resolveOpenApiRef(container.schema, spec));
}

function exampleFromSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues?.length) return enumValues[0];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "array") {
    const item = exampleFromSchema(schema.items);
    return item === undefined ? undefined : [item];
  }
  if (type !== "object" && !isRecord(schema.properties)) return primitiveExampleForType(type);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const keys = (required.length ? required : Object.keys(properties)).slice(0, 12);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = exampleFromSchema(properties[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function primitiveExampleForType(type: string | undefined): unknown {
  if (type === "string") return "example";
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  return undefined;
}
