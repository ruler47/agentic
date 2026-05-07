// Shared validation/parsing helpers used by Nest services.
// Mirrors the bespoke `parseXxxInput` functions in the legacy
// src/server/http.ts. Once cutover happens (Phase 5), the legacy file
// is removed; this one stays as the single source of truth.

import type { ToolSchema, ToolStartupMode } from "../../tools/tool.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

export function parseOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseOptionalTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function parseOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function parseRequiredStringArray(value: unknown, name: string): string[] {
  const parsed = parseOptionalStringArray(value, name);
  if (!parsed?.length) throw new Error(`${name} must contain at least one value`);
  return parsed;
}

export function parseOptionalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error(`${name} must be a relative project path`);
  }
  return trimmed;
}

export function parseRequiredPath(value: unknown, name: string): string {
  const parsed = parseOptionalPath(value, name);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

export function parseOptionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be an ISO date string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO date string`);
  }
  return parsed;
}

export function parseStartupMode(value: unknown): ToolStartupMode | undefined {
  if (value === undefined) return undefined;
  if (value === "always-on" || value === "on-demand" || value === "ephemeral") return value;
  throw new Error("startupMode is invalid");
}

export function parseOptionalToolSchema(value: unknown, name: string): ToolSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "object" || !candidate.properties || typeof candidate.properties !== "object") {
    throw new Error(`${name} must be a ToolSchema object`);
  }
  return candidate as ToolSchema;
}

export function parseOptionalConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const confidence = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  return confidence;
}

export function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${field} must be an integer from 1 to 100`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return Math.floor(parsed);
}

export function parseOptionalMinimumNumber(value: unknown, fieldName: string, minimum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${fieldName} must be a number greater than or equal to ${minimum}`);
  }
  return parsed;
}

export function parseOptionalNumberInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${fieldName} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function parseNullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseNullableNumber(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number or null`);
  return number;
}

export function parseUpdateNullableText(
  candidate: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in candidate)) return undefined;
  const value = candidate[key];
  if (value === undefined) return undefined;
  return parseNullableText(value, key);
}

export function parseUpdateNullableNumber(
  candidate: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in candidate)) return undefined;
  return parseNullableNumber(candidate[key], key);
}

export function parseRequiredEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseLimit(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

export function parseOptionalReason(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : undefined;
}

export function parseOptionalPreferences(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("preferences must be an object");
  }
  return sanitizeObject(value);
}

export function sanitizeAuditMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return sanitizeObject(value);
}

export function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("api_key")
    ) {
      result[key] = "[redacted]";
    } else if (isRecord(item)) {
      result[key] = sanitizeObject(item);
    } else if (Array.isArray(item)) {
      result[key] = item.map((entry) => (isRecord(entry) ? sanitizeObject(entry) : entry));
    } else {
      result[key] = item;
    }
  }
  return result;
}
