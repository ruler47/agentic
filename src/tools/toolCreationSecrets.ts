import type { SecretHandleRecord, SecretHandleStore } from "../secrets/secretHandleStore.js";
import type { ToolBuilderPlan } from "./toolBuilderAgent.js";
import type { ToolIntegrationContract } from "./toolIntegrationContract.js";

export type ToolCreationExtractedSecret = {
  purpose: string;
  value: string;
  sourcePath: string;
};

export type ToolCreationSecretPreparation = {
  input: unknown;
  extractedSecrets: ToolCreationExtractedSecret[];
  redactionNotes: string[];
};

export type StoredToolCreationSecret = {
  handle: string;
  purpose: string;
  sourcePath: string;
};

type SecretMatch = {
  purpose: string;
  value: string;
};

const SECRET_KEY_PATTERN = /(?:^|[_\-. ])(?:api[_\-. ]?key|access[_\-. ]?token|bot[_\-. ]?token|bearer[_\-. ]?token|token|secret|password)(?:$|[_\-. ])/i;

const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\b(authorization\s*[:=]\s*bearer\s+)([A-Za-z0-9._~+/=:-]{12,})/gi,
  /\b(x-api-key\s*[:=]\s*["']?)([^\s"',;`]{12,})/gi,
  /\b((?:api[_\-. ]?key|access[_\-. ]?token|bot[_\-. ]?token|telegram[_\-. ]?bot[_\-. ]?token|bearer[_\-. ]?token|token|secret)\s*[:=]\s*["']?)([^\s"',;`]{12,})["']?/gi,
];

export function prepareToolCreationSecrets(rawInput: unknown): ToolCreationSecretPreparation {
  const extractedSecrets: ToolCreationExtractedSecret[] = [];
  const seen = new Set<string>();

  const redactedInput = redactUnknown(rawInput, "$", (secret) => {
    const dedupeKey = `${secret.purpose}\0${secret.value}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      extractedSecrets.push(secret);
    }
  });
  const input = addCredentialHints(redactedInput, extractedSecrets);

  return {
    input,
    extractedSecrets,
    redactionNotes: extractedSecrets.map(
      (secret) => `Extracted ${secret.purpose} from ${secret.sourcePath} into a tool-scoped secret handle.`,
    ),
  };
}

export function redactToolCreationTracePayload(payload: unknown): unknown {
  return redactUnknown(payload, "$", () => {});
}

function addCredentialHints(
  input: unknown,
  extractedSecrets: ToolCreationExtractedSecret[],
): unknown {
  if (extractedSecrets.length === 0 || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  const purposes = uniqueStrings(extractedSecrets.map((secret) => secret.purpose));
  if (typeof record.request !== "string") {
    return {
      ...record,
      credentialPurposes: purposes,
    };
  }
  const credentialText = purposes.join(", ");
  const request = /\b(api\s*key|token|bearer|secret|credential)\b/i.test(record.request)
    ? record.request
    : `${record.request.trim()}\nCredential provided through secret handle: ${credentialText}.`;
  return {
    ...record,
    request,
    credentialPurposes: purposes,
  };
}

export async function persistToolCreationSecrets(input: {
  extractedSecrets: ToolCreationExtractedSecret[];
  toolName: string;
  store?: SecretHandleStore;
}): Promise<StoredToolCreationSecret[]> {
  if (input.extractedSecrets.length === 0) return [];
  if (!input.store) {
    throw new Error("Tool creation request contains raw credentials, but secret handle store is not configured.");
  }
  const counts = new Map<string, number>();
  const stored: StoredToolCreationSecret[] = [];

  for (const secret of input.extractedSecrets) {
    const purposeSegment = secretPurposeSegment(secret.purpose);
    const count = (counts.get(purposeSegment) ?? 0) + 1;
    counts.set(purposeSegment, count);
    const handle = scopedSecretHandle(input.toolName, purposeSegment, count);
    const record = await input.store.create({
      handle,
      label: `${input.toolName} ${secret.purpose}`,
      provider: "inline",
      secretRef: secret.value,
      scopes: ["instance-local", `tool:${input.toolName}`],
    });
    stored.push({
      handle: record.handle,
      purpose: secret.purpose,
      sourcePath: secret.sourcePath,
    });
  }
  return stored;
}

export function applyStoredSecretsToToolBuilderPlan(
  plan: ToolBuilderPlan,
  storedSecrets: StoredToolCreationSecret[],
): ToolBuilderPlan {
  if (storedSecrets.length === 0) return plan;
  const integrationContract = withSecretHandles(plan.input.integrationContract, storedSecrets);
  const strategyIntegrationContract = withSecretHandles(plan.strategy.integrationContract, storedSecrets);
  const fallbackHandles = plan.input.integrationContract ? [] : storedSecrets.map((secret) => secret.handle);
  const requiredSecretHandles = uniqueStrings([
    ...(plan.input.requiredSecretHandles ?? []).filter((handle) => !isGenericSecretHandle(handle)),
    ...integrationContractSecretHandles(integrationContract),
    ...fallbackHandles,
  ]);

  return {
    ...plan,
    input: {
      ...plan.input,
      integrationContract,
      requiredSecretHandles,
    },
    strategy: {
      ...plan.strategy,
      integrationContract: strategyIntegrationContract,
      implementationNotes: [
        ...plan.strategy.implementationNotes,
        `Tool-scoped secret handle(s) registered for this extension: ${storedSecrets.map((secret) => secret.handle).join(", ")}.`,
      ],
    },
  };
}

export function publicStoredSecretSummary(storedSecrets: StoredToolCreationSecret[]): Array<{
  handle: string;
  purpose: string;
  sourcePath: string;
}> {
  return storedSecrets.map((secret) => ({
    handle: secret.handle,
    purpose: secret.purpose,
    sourcePath: secret.sourcePath,
  }));
}

function redactUnknown(
  value: unknown,
  path: string,
  onSecret: (secret: ToolCreationExtractedSecret) => void,
): unknown {
  if (typeof value === "string") return redactString(value, path, undefined, onSecret);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}[${index}]`, onSecret));
  }
  const result: Record<string, unknown> = {};
  const isCredentialContainer = isCredentialContainerPath(path);
  let redactedCredentialKeyCount = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const itemPath = `${path}.${key}`;
    const outputKey =
      isCredentialContainer && !isSafeCredentialFieldName(key)
        ? `credential${redactedCredentialKeyCount++ === 0 ? "" : redactedCredentialKeyCount}`
        : key;
    if (typeof item === "string") {
      result[outputKey] = redactString(item, itemPath, key, onSecret);
    } else {
      result[outputKey] = redactUnknown(item, itemPath, onSecret);
    }
  }
  return result;
}

function redactString(
  value: string,
  sourcePath: string,
  key: string | undefined,
  onSecret: (secret: ToolCreationExtractedSecret) => void,
): string {
  if (isCredentialValuePath(sourcePath) && isRawSecretValue(value)) {
    const purpose = key && isSecretKey(key) ? secretPurposeFromKey(key) : "credential";
    onSecret({ purpose, value, sourcePath: normalizeSecretSourcePath(sourcePath) });
    return `[secret redacted: ${purpose}]`;
  }

  if (key && isSecretKey(key) && isRawSecretValue(value)) {
    const purpose = secretPurposeFromKey(key);
    onSecret({ purpose, value, sourcePath: normalizeSecretSourcePath(sourcePath) });
    return `[secret redacted: ${purpose}]`;
  }

  let redacted = value;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      const groups = args.slice(1, -2).filter((item): item is string => typeof item === "string");
      const valueCandidate = groups[groups.length - 1] ?? "";
      if (!isRawSecretValue(valueCandidate)) return String(args[0]);
      const label = groups.length > 2 ? groups[groups.length - 2] : groups[0];
      const purpose = secretPurposeFromKey(label);
      onSecret({ purpose, value: valueCandidate, sourcePath: normalizeSecretSourcePath(sourcePath) });
      const prefix = groups.length > 1 ? groups[0] : `${label}: `;
      return `${prefix}[secret redacted: ${purpose}]`;
    });
  }
  return redacted;
}

function isCredentialValuePath(sourcePath: string): boolean {
  return /(?:^|[.[\]])credentials?(?:$|[.\[\]])/i.test(sourcePath);
}

function isCredentialContainerPath(sourcePath: string): boolean {
  return /(?:^|[.[\]])credentials?$/i.test(sourcePath);
}

function isSafeCredentialFieldName(key: string): boolean {
  if (!/^[a-z][a-z0-9_. -]{0,63}$/i.test(key)) return false;
  return !isRawSecretValue(key);
}

function normalizeSecretSourcePath(sourcePath: string): string {
  return sourcePath.replace(/(\.credentials?\.)([^.[\]]+)/gi, "$1<credential>");
}

function isSecretKey(key: string): boolean {
  if (/requiredSecretHandles|secretRef|secretHandle/i.test(key)) return false;
  const normalized = splitKeyWords(key);
  return SECRET_KEY_PATTERN.test(`.${normalized}.`);
}

function isRawSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12 || trimmed.length > 4096) return false;
  if (/^\[?(?:redacted|secret redacted|secret-handle)/i.test(trimmed)) return false;
  if (/^secret\.[a-z0-9._:-]+$/i.test(trimmed)) return false;
  if (/^[A-Z][A-Z0-9_]{2,127}$/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^(your|example|sample|placeholder)[-_ ]/i.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed) && /[0-9._~+/=:-]/.test(trimmed);
}

function secretPurposeFromKey(key: string): string {
  const normalized = splitKeyWords(key);
  if (normalized.includes("telegram") && normalized.includes("bot")) return "telegram bot token";
  if (normalized.includes("bearer")) return "bearer token";
  if (normalized.includes("access") && normalized.includes("token")) return "access token";
  if (normalized.includes("api") && normalized.includes("key")) return "api key";
  if (normalized.includes("bot") && normalized.includes("token")) return "bot token";
  if (normalized.includes("password")) return "password";
  if (normalized.includes("secret")) return "secret";
  return "token";
}

function splitKeyWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function secretPurposeSegment(purpose: string): string {
  return purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "credential";
}

function scopedSecretHandle(toolName: string, purposeSegment: string, count: number): string {
  const suffix = count > 1 ? `.${count}` : "";
  return `secret.tool.${toolNameSegment(toolName)}.${purposeSegment}${suffix}`.slice(0, 127).replace(/[.-]+$/g, "");
}

function toolNameSegment(toolName: string): string {
  return toolName
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/[._:-]+$/g, "")
    .slice(0, 72) || "tool";
}

function withSecretHandles(
  contract: ToolIntegrationContract | undefined,
  secrets: StoredToolCreationSecret[],
): ToolIntegrationContract | undefined {
  if (!contract) return contract;
  const auth = contract.auth
    ? {
        ...contract.auth,
        requiredSecretHandles: mergeMatchedSecretHandles(secrets, contract.auth, contract.auth.requiredSecretHandles),
      }
    : contract.auth;
  const authHandles = auth?.requiredSecretHandles;
  return {
    ...contract,
    auth,
    operations: contract.operations.map((operation) => ({
      ...operation,
      requiredSecretHandles: operation.requiredSecretHandles
        ? mergeMatchedSecretHandles(secrets, auth, operation.requiredSecretHandles)
        : authHandles && authHandles.length > 0
          ? authHandles
        : operation.requiredSecretHandles,
    })),
  };
}

function mergeMatchedSecretHandles(
  secrets: StoredToolCreationSecret[],
  auth: ToolIntegrationContract["auth"],
  existing: string[] | undefined,
): string[] {
  const matching = secrets
    .filter((secret) => secretMatchesAuth(secret, auth))
    .map((secret) => secret.handle);
  if (matching.length === 0) return (existing ?? []).filter((handle) => !isGenericSecretHandle(handle));
  return uniqueStrings([
    ...matching,
    ...(existing ?? []).filter((handle) => !isGenericSecretHandle(handle)),
  ]);
}

function secretMatchesAuth(secret: StoredToolCreationSecret, auth: ToolIntegrationContract["auth"]): boolean {
  if (!auth || auth.type === "none") return false;
  const purpose = splitKeyWords(secret.purpose);
  if (purpose.includes("credential")) return true;
  const credentialName = splitKeyWords(auth.credentialName ?? "");
  if (auth.type === "api-key") {
    if (credentialName.includes("token") && purpose.includes("token")) return true;
    return purpose.includes("api") && purpose.includes("key");
  }
  if (auth.type === "bearer-token" || auth.type === "oauth2") {
    return purpose.includes("bearer") || purpose.includes("access") || purpose.includes("token");
  }
  if (auth.type === "bot-token") return purpose.includes("bot") && purpose.includes("token");
  if (auth.type === "basic") return purpose.includes("password") || purpose.includes("secret");
  return purpose.includes("secret") || purpose.includes("token") || purpose.includes("key");
}

function isGenericSecretHandle(handle: string): boolean {
  return /^secret\.(api\.integration|integration\.token|telegram\.bot|[^.]+\.integration)$/i.test(handle);
}

function integrationContractSecretHandles(contract: ToolIntegrationContract | undefined): string[] {
  if (!contract) return [];
  return [
    ...(contract.auth?.requiredSecretHandles ?? []),
    ...contract.operations.flatMap((operation) => operation.requiredSecretHandles ?? []),
  ];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
