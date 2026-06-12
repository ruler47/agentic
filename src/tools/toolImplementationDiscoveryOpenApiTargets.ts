import type { ToolIntegrationTarget } from "./toolIntegrationContract.js";
import { isRecord } from "./toolImplementationDiscoveryNpmReadme.js";

type OpenApiServer = { url?: unknown; description?: unknown; variables?: unknown };
type OpenApiSpecLike = {
  info?: { title?: unknown; description?: unknown };
  servers?: OpenApiServer[];
};

export function firstOpenApiServerUrl(spec: OpenApiSpecLike): string | undefined {
  let firstTemplate: string | undefined;
  for (const server of spec.servers ?? []) {
    if (typeof server.url === "string" && !firstTemplate) {
      firstTemplate = server.url.replace(/\/+$/, "");
    }
    const expanded = expandOpenApiServerUrls(server).find(isConcreteLiveServerUrl);
    if (expanded) return expanded;
  }
  return firstTemplate;
}

export function listOpenApiTargets(spec: OpenApiSpecLike): ToolIntegrationTarget[] {
  const servers = spec.servers ?? [];
  const out: ToolIntegrationTarget[] = [];
  for (const server of servers) {
    const description = typeof server.description === "string" ? server.description.trim() : "";
    const humanAliases = inferServerVariableHumanAliases(spec, server);
    for (const baseUrl of expandOpenApiServerUrls(server)) {
      if (!isConcreteLiveServerUrl(baseUrl)) continue;
      const id = uniqueTargetId(targetIdFromServer(baseUrl, description), out);
      out.push({
        id,
        label: description || id,
        baseUrl,
        aliases: targetAliasesFromServer(baseUrl, description, id, humanAliasesForUrl(baseUrl, humanAliases)),
        ...(description ? { description } : {}),
        metadata: { source: "openapi.servers" },
      });
    }
  }
  return out;
}

function expandOpenApiServerUrls(server: OpenApiServer): string[] {
  if (typeof server.url !== "string") return [];
  const template = server.url.replace(/\/+$/, "");
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
  if (names.length === 0) return [template];
  const variables = isRecord(server.variables) ? server.variables : {};
  const values = names.map((name) => openApiServerVariableValues(variables[name]));
  if (values.some((items) => items.length === 0)) return [template];
  const expanded: string[] = [];
  const walk = (index: number, current: string) => {
    if (expanded.length >= 50) return;
    const name = names[index];
    if (!name) {
      expanded.push(current);
      return;
    }
    for (const value of values[index] ?? []) {
      walk(index + 1, current.replaceAll(`{${name}}`, value));
    }
  };
  walk(0, template);
  return expanded;
}

function openApiServerVariableValues(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const enumValues = Array.isArray(value.enum)
    ? value.enum.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const fallback = typeof value.default === "string" && value.default.trim() ? [value.default] : [];
  return uniqueStrings([...enumValues, ...fallback]).slice(0, 50);
}

function inferServerVariableHumanAliases(spec: OpenApiSpecLike, server: OpenApiServer): Record<string, string[]> {
  const variables = isRecord(server.variables) ? Object.values(server.variables) : [];
  if (variables.length !== 1 || !isRecord(variables[0])) return {};
  const enumValues = openApiServerVariableValues(variables[0]);
  if (enumValues.length === 0) return {};
  const text = [
    typeof spec.info?.title === "string" ? spec.info.title : "",
    typeof spec.info?.description === "string" ? spec.info.description : "",
    typeof server.description === "string" ? server.description : "",
    typeof variables[0].description === "string" ? variables[0].description : "",
  ].join("\n");
  const labels = parenthesizedCommaLists(text).find((items) => items.length === enumValues.length);
  if (!labels) return {};
  return Object.fromEntries(enumValues.map((value, index) => [normalizeTargetAlias(value), [labels[index] ?? ""]]));
}

function parenthesizedCommaLists(text: string): string[][] {
  return [...text.matchAll(/\(([^()]{8,300})\)/g)]
    .map((match) => (match[1] ?? "").split(",").map((item) => normalizeTargetAlias(item)).filter(Boolean))
    .filter((items) => items.length > 1);
}

function humanAliasesForUrl(baseUrl: string, aliasesByValue: Record<string, string[]>): string[] {
  const normalizedUrl = normalizeTargetAlias(baseUrl);
  return Object.entries(aliasesByValue).flatMap(([value, aliases]) =>
    normalizedUrl.split("-").includes(value) ? aliases : [],
  );
}

function uniqueTargetId(base: string, existing: ToolIntegrationTarget[]): string {
  let id = base || "target";
  let suffix = 2;
  while (existing.some((target) => target.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function targetIdFromServer(baseUrl: string, description: string): string {
  const descriptionId = normalizeTargetAlias(description);
  if (descriptionId) return descriptionId;
  try {
    const url = new URL(baseUrl);
    const hostParts = url.hostname.split(".").filter(Boolean);
    const host = normalizeTargetAlias(hostParts[0] ?? url.hostname);
    const path = normalizeTargetAlias(url.pathname);
    return normalizeTargetAlias([host, path].filter(Boolean).join("-")) || "target";
  } catch {
    return "target";
  }
}

function targetAliasesFromServer(baseUrl: string, description: string, id: string, extraAliases: string[]): string[] {
  const values = [id, description, ...extraAliases];
  try {
    const url = new URL(baseUrl);
    values.push(url.hostname, ...url.hostname.split("."), url.pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    values.push(baseUrl);
  }
  const aliases = values.flatMap((value) => {
    const alias = normalizeTargetAlias(value);
    const words = value
      .split(/[^A-Za-z0-9]+/g)
      .map(normalizeTargetAlias)
      .filter((word) => word.length >= 3 && !["api", "target", "global", "ledger"].includes(word));
    return alias ? [alias, ...words] : words;
  });
  return [...new Set(aliases)].filter((alias) => alias !== id).slice(0, 16);
}

function normalizeTargetAlias(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isConcreteLiveServerUrl(value: string | undefined): boolean {
  if (!value || /[{}]/u.test(value) || /[-/]$/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
