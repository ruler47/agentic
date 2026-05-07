/**
 * Recursively redact secret-shaped keys from arbitrary metadata payloads. Mirrors the
 * existing redaction behaviour used by `toolInvestigationStore.sanitizeContextBundle`,
 * so any work/evidence/retrospective metadata accepted from an HTTP body or an agent
 * runtime cannot leak credentials into audit metadata or store rows.
 */
export function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return sanitizeRecord(value as Record<string, unknown>);
}

export function sanitizeForLedger(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLedger(item));
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("credential") ||
    lower.includes("authorization") ||
    lower === "auth"
  );
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitizeForLedger(item);
  }
  return result;
}
