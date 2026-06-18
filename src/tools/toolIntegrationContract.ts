import type { ToolSchema } from "./tool.js";

export type ToolIntegrationMode = "run-on-demand" | "always-on-service";

export type ToolIntegrationProtocol =
  | "http-api"
  | "messaging-bot"
  | "webhook"
  | "database"
  | "browser"
  | "npm-library"
  | "custom";

export type ToolIntegrationAuth = {
  type: "none" | "api-key" | "bearer-token" | "bot-token" | "basic" | "oauth2" | "custom";
  credentialLocation?: "header" | "query" | "cookie";
  credentialName?: string;
  authorizationScheme?: string;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
  notes?: string;
};

export type ToolIntegrationOperation = {
  name: string;
  description?: string;
  direction:
    | "outbound-request"
    | "inbound-event"
    | "outbound-event"
    | "query"
    | "mutation"
    | "lifecycle";
  method?: string;
  path?: string;
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
};

export type ToolIntegrationTarget = {
  id: string;
  label?: string;
  baseUrl: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ToolIntegrationContract = {
  schemaVersion: "agentic.tool-integration.v1";
  mode: ToolIntegrationMode;
  protocol: ToolIntegrationProtocol;
  provider?: string;
  baseUrl?: string;
  targets?: ToolIntegrationTarget[];
  auth?: ToolIntegrationAuth;
  operations: ToolIntegrationOperation[];
  inboundEventSchema?: ToolSchema;
  outboundEventSchema?: ToolSchema;
  callbackStrategy?: "runtime-callbacks" | "webhook" | "polling" | "none";
  notes?: string[];
};

export function mergeToolIntegrationContracts(
  base: ToolIntegrationContract | undefined,
  update: ToolIntegrationContract | undefined,
): ToolIntegrationContract | undefined {
  if (!base) return update;
  if (!update) return base;
  const auth = mergeAuth(base.auth, update.auth);
  const authHandles = auth?.requiredSecretHandles;
  return {
    ...base,
    provider: update.provider ?? base.provider,
    baseUrl: update.baseUrl ?? base.baseUrl,
    targets: mergeTargets(base.targets, update.targets),
    auth,
    operations: mergeOperations(base.operations, update.operations, authHandles),
    inboundEventSchema: update.inboundEventSchema ?? base.inboundEventSchema,
    outboundEventSchema: update.outboundEventSchema ?? base.outboundEventSchema,
    callbackStrategy: update.callbackStrategy ?? base.callbackStrategy,
    notes: uniqueStrings([...(base.notes ?? []), ...(update.notes ?? [])]),
  };
}

export function normalizeToolIntegrationContract(input: unknown): ToolIntegrationContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("integration contract must be an object.");
  }
  const candidate = input as Record<string, unknown>;
  const contract: ToolIntegrationContract = {
    schemaVersion: literal(candidate.schemaVersion, "agentic.tool-integration.v1", "integration.schemaVersion"),
    mode: integrationMode(candidate.mode),
    protocol: integrationProtocol(candidate.protocol),
    provider: optionalText(candidate.provider, "integration.provider"),
    baseUrl: optionalText(candidate.baseUrl, "integration.baseUrl"),
    targets: parseTargets(candidate.targets),
    auth: parseAuth(candidate.auth),
    operations: parseOperations(candidate.operations),
    inboundEventSchema: optionalSchema(candidate.inboundEventSchema, "integration.inboundEventSchema"),
    outboundEventSchema: optionalSchema(candidate.outboundEventSchema, "integration.outboundEventSchema"),
    callbackStrategy: callbackStrategy(candidate.callbackStrategy),
    notes: optionalStringArray(candidate.notes, "integration.notes"),
  };
  if (contract.mode === "always-on-service" && !contract.operations.some((operation) => operation.direction === "inbound-event" || operation.direction === "lifecycle")) {
    throw new Error("always-on integration contracts must declare an inbound-event or lifecycle operation.");
  }
  return contract;
}

function mergeTargets(
  base: ToolIntegrationTarget[] | undefined,
  update: ToolIntegrationTarget[] | undefined,
): ToolIntegrationTarget[] | undefined {
  const out = [...(base ?? [])];
  for (const target of update ?? []) {
    const index = out.findIndex((item) => item.id === target.id || item.baseUrl === target.baseUrl);
    if (index >= 0) {
      out[index] = {
        ...out[index],
        ...target,
        aliases: uniqueStrings([...(out[index]?.aliases ?? []), ...(target.aliases ?? [])]),
        metadata: { ...(out[index]?.metadata ?? {}), ...(target.metadata ?? {}) },
      };
    } else {
      out.push(target);
    }
  }
  return out.length > 0 ? out.slice(0, 50) : undefined;
}

function mergeAuth(
  base: ToolIntegrationAuth | undefined,
  update: ToolIntegrationAuth | undefined,
): ToolIntegrationAuth | undefined {
  if (!base || base.type === "none") return update ?? base;
  if (!update || update.type === "none") return base;
  return {
    ...base,
    credentialLocation: update.credentialLocation ?? base.credentialLocation,
    credentialName: update.credentialName ?? base.credentialName,
    authorizationScheme: update.authorizationScheme ?? base.authorizationScheme,
    requiredSecretHandles: mergeSecretHandles(base.requiredSecretHandles, update.requiredSecretHandles),
    requiredConfigurationKeys: uniqueStrings([
      ...(base.requiredConfigurationKeys ?? []),
      ...(update.requiredConfigurationKeys ?? []),
    ]),
    notes: [base.notes, update.notes].filter(Boolean).join(" "),
  };
}

function mergeOperations(
  base: ToolIntegrationOperation[],
  update: ToolIntegrationOperation[],
  authHandles: string[] | undefined,
): ToolIntegrationOperation[] {
  const out = base.map((operation) => normalizeOperationSecretHandles(operation, authHandles));
  for (const operation of update) {
    const normalized = normalizeOperationSecretHandles(operation, authHandles);
    const index = out.findIndex((item) => operationKey(item) === operationKey(normalized));
    if (index >= 0) out[index] = { ...out[index], ...normalized };
    else out.push(normalized);
  }
  return out.slice(0, 20);
}

function normalizeOperationSecretHandles(
  operation: ToolIntegrationOperation,
  authHandles: string[] | undefined,
): ToolIntegrationOperation {
  return {
    ...operation,
    requiredSecretHandles: mergeSecretHandles(authHandles, operation.requiredSecretHandles),
  };
}

function operationKey(operation: ToolIntegrationOperation): string {
  return [operation.name, operation.method ?? "", operation.path ?? ""].join("\0");
}

function mergeSecretHandles(base: string[] | undefined, update: string[] | undefined): string[] | undefined {
  const baseConcrete = (base ?? []).filter((handle) => !isGenericIntegrationSecretHandle(handle));
  const updateConcrete = (update ?? []).filter((handle) => !isGenericIntegrationSecretHandle(handle));
  const values = updateConcrete.length > 0
    ? [...updateConcrete, ...baseConcrete]
    : baseConcrete.length > 0
      ? baseConcrete
      : [...(base ?? []), ...(update ?? [])];
  const unique = uniqueStrings(values);
  return unique.length > 0 ? unique : undefined;
}

function isGenericIntegrationSecretHandle(handle: string): boolean {
  return /^secret\.(api\.integration|integration\.token|telegram\.bot|api\.[^.]+|[^.]+\.integration)$/i.test(handle);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseTargets(value: unknown): ToolIntegrationTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("integration.targets must be an array.");
  const targets = value.slice(0, 50).map((item, index): ToolIntegrationTarget => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`integration.targets[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      id: requiredText(candidate.id, `integration.targets[${index}].id`),
      label: optionalText(candidate.label, `integration.targets[${index}].label`),
      baseUrl: requiredText(candidate.baseUrl, `integration.targets[${index}].baseUrl`),
      aliases: optionalStringArray(candidate.aliases, `integration.targets[${index}].aliases`),
      description: optionalText(candidate.description, `integration.targets[${index}].description`),
      metadata: optionalRecord(candidate.metadata, `integration.targets[${index}].metadata`),
    };
  });
  return targets.length > 0 ? targets : undefined;
}

function parseAuth(value: unknown): ToolIntegrationAuth | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("integration.auth must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (
    type !== "none" &&
    type !== "api-key" &&
    type !== "bearer-token" &&
    type !== "bot-token" &&
    type !== "basic" &&
    type !== "oauth2" &&
    type !== "custom"
  ) {
    throw new Error("integration.auth.type is invalid.");
  }
  return {
    type,
    credentialLocation: credentialLocation(candidate.credentialLocation),
    credentialName: optionalText(candidate.credentialName, "integration.auth.credentialName"),
    authorizationScheme: optionalText(candidate.authorizationScheme, "integration.auth.authorizationScheme"),
    requiredSecretHandles: optionalStringArray(candidate.requiredSecretHandles, "integration.auth.requiredSecretHandles"),
    requiredConfigurationKeys: optionalStringArray(candidate.requiredConfigurationKeys, "integration.auth.requiredConfigurationKeys"),
    notes: optionalText(candidate.notes, "integration.auth.notes"),
  };
}

function credentialLocation(value: unknown): ToolIntegrationAuth["credentialLocation"] {
  if (value === undefined) return undefined;
  if (value === "header" || value === "query" || value === "cookie") return value;
  throw new Error("integration.auth.credentialLocation is invalid.");
}

function parseOperations(value: unknown): ToolIntegrationOperation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("integration.operations must be a non-empty array.");
  }
  return value.slice(0, 20).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`integration.operations[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    return {
      name: requiredText(candidate.name, `integration.operations[${index}].name`),
      description: optionalText(candidate.description, `integration.operations[${index}].description`),
      direction: operationDirection(candidate.direction, `integration.operations[${index}].direction`),
      method: optionalText(candidate.method, `integration.operations[${index}].method`)?.toUpperCase(),
      path: optionalText(candidate.path, `integration.operations[${index}].path`),
      inputSchema: optionalSchema(candidate.inputSchema, `integration.operations[${index}].inputSchema`),
      outputSchema: optionalSchema(candidate.outputSchema, `integration.operations[${index}].outputSchema`),
      requiredSecretHandles: optionalStringArray(candidate.requiredSecretHandles, `integration.operations[${index}].requiredSecretHandles`),
      requiredConfigurationKeys: optionalStringArray(candidate.requiredConfigurationKeys, `integration.operations[${index}].requiredConfigurationKeys`),
    };
  });
}

function operationDirection(value: unknown, field: string): ToolIntegrationOperation["direction"] {
  if (
    value === "outbound-request" ||
    value === "inbound-event" ||
    value === "outbound-event" ||
    value === "query" ||
    value === "mutation" ||
    value === "lifecycle"
  ) return value;
  throw new Error(`${field} is invalid.`);
}

function integrationMode(value: unknown): ToolIntegrationMode {
  if (value === "run-on-demand" || value === "always-on-service") return value;
  throw new Error("integration.mode must be run-on-demand or always-on-service.");
}

function integrationProtocol(value: unknown): ToolIntegrationProtocol {
  if (
    value === "http-api" ||
    value === "messaging-bot" ||
    value === "webhook" ||
    value === "database" ||
    value === "browser" ||
    value === "npm-library" ||
    value === "custom"
  ) return value;
  throw new Error("integration.protocol is invalid.");
}

function callbackStrategy(value: unknown): ToolIntegrationContract["callbackStrategy"] {
  if (value === undefined) return undefined;
  if (value === "runtime-callbacks" || value === "webhook" || value === "polling" || value === "none") return value;
  throw new Error("integration.callbackStrategy is invalid.");
}

function optionalSchema(value: unknown, field: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as ToolSchema;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function literal<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${expected}.`);
  return expected;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item, index) => requiredText(item, `${field}[${index}]`));
}
