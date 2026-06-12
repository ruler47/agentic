import { isRecord } from "./toolImplementationDiscoveryNpmReadme.js";

type YamlLine = {
  indent: number;
  content: string;
};

export function parseYamlOpenApiSpec(text: string): Record<string, unknown> | undefined {
  const specs = yamlCandidates(text).flatMap((candidate) => {
    const lines = normalizeYamlLines(candidate);
    if (lines.length === 0 || !lines.some((line) => /^(?:openapi|swagger)\s*:/i.test(line.content))) return [];
    const { value } = parseYamlBlock(lines, 0, lines[0]?.indent ?? 0);
    return isRecord(value) && (value.openapi || value.swagger) && value.paths ? [value] : [];
  });
  const uniqueSpecs = uniqueYamlOpenApiSpecs(specs);
  if (uniqueSpecs.length === 0) return undefined;
  return uniqueSpecs.length === 1 ? uniqueSpecs[0] : mergeYamlOpenApiSpecs(uniqueSpecs);
}

function yamlCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:ya?ml|openapi)?\s*([\s\S]*?)```/giu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const openApiMatches = [...text.matchAll(/(^|\n)\s*(?:openapi|swagger)\s*:/giu)];
  const embedded = openApiMatches
    .map((match, index) => {
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      const next = openApiMatches[index + 1];
      const hardEnd = next?.index ?? text.length;
      const candidate = text.slice(start, hardEnd).split(/\n\s*---\s*\n/)[0]?.trim() ?? "";
      return candidate;
    })
    .filter(Boolean);
  return [...new Set([...fenced, ...embedded, text.trim()])]
    .filter((value) => /(?:^|\n)\s*(?:openapi|swagger)\s*:/i.test(value));
}

function mergeYamlOpenApiSpecs(specs: Record<string, unknown>[]): Record<string, unknown> {
  const [first = {}] = specs;
  return {
    ...first,
    servers: specs.flatMap((spec) => Array.isArray(spec.servers) ? spec.servers : []),
    security: specs.flatMap((spec) => Array.isArray(spec.security) ? spec.security : []),
    paths: Object.assign({}, ...specs.map((spec) => isRecord(spec.paths) ? spec.paths : {})),
    components: Object.assign({}, ...specs.map((spec) => isRecord(spec.components) ? spec.components : {})),
  };
}

function uniqueYamlOpenApiSpecs(specs: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = JSON.stringify({
      servers: spec.servers,
      paths: spec.paths,
      security: spec.security,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeYamlLines(text: string): YamlLine[] {
  return text
    .replace(/\t/g, "  ")
    .split(/\r?\n/)
    .map((raw) => ({
      indent: raw.match(/^ */)?.[0].length ?? 0,
      content: raw.trim(),
    }))
    .filter((line) => line.content && !line.content.startsWith("#"));
}

function parseYamlBlock(lines: YamlLine[], index: number, indent: number): { value: unknown; index: number } {
  const line = lines[index];
  if (!line || line.indent < indent) return { value: {}, index };
  if (line.indent === indent && line.content.startsWith("- ")) {
    return parseYamlArray(lines, index, indent);
  }
  return parseYamlMap(lines, index, indent);
}

function parseYamlMap(lines: YamlLine[], index: number, indent: number): { value: Record<string, unknown>; index: number } {
  const out: Record<string, unknown> = {};
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line || line.indent < indent || (line.indent === indent && line.content.startsWith("- "))) break;
    if (line.indent > indent) {
      cursor += 1;
      continue;
    }
    const pair = splitYamlPair(line.content);
    if (!pair) {
      cursor += 1;
      continue;
    }
    const [key, rawValue] = pair;
    const trimmedValue = rawValue.trim();
    if (trimmedValue) {
      if (trimmedValue === "|" || trimmedValue === ">") {
        const parsed = parseYamlBlockScalar(lines, cursor + 1, line.indent, trimmedValue);
        out[key] = parsed.value;
        cursor = parsed.index;
        continue;
      }
      out[key] = parseYamlScalar(trimmedValue);
      cursor += 1;
      continue;
    }
    const next = lines[cursor + 1];
    if (!next || next.indent <= line.indent) {
      out[key] = {};
      cursor += 1;
      continue;
    }
    const parsed = parseYamlBlock(lines, cursor + 1, next.indent);
    out[key] = parsed.value;
    cursor = parsed.index;
  }
  return { value: out, index: cursor };
}

function parseYamlArray(lines: YamlLine[], index: number, indent: number): { value: unknown[]; index: number } {
  const out: unknown[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line || line.indent !== indent || !line.content.startsWith("- ")) break;
    const rest = line.content.slice(2).trim();
    if (!rest) {
      const nested = lines[cursor + 1];
      if (!nested || nested.indent <= indent) {
        out.push(null);
        cursor += 1;
      } else {
        const parsed = parseYamlBlock(lines, cursor + 1, nested.indent);
        out.push(parsed.value);
        cursor = parsed.index;
      }
      continue;
    }
    const pair = splitYamlPair(rest);
    if (!pair) {
      out.push(parseYamlScalar(rest));
      cursor += 1;
      continue;
    }
    const item: Record<string, unknown> = {};
    const [key, rawValue] = pair;
    const trimmedValue = rawValue.trim();
    if (trimmedValue === "|" || trimmedValue === ">") {
      const parsed = parseYamlBlockScalar(lines, cursor + 1, indent, trimmedValue);
      item[key] = parsed.value;
      cursor = parsed.index;
      out.push(item);
      continue;
    }
    item[key] = trimmedValue ? parseYamlScalar(trimmedValue) : {};
    const next = lines[cursor + 1];
    if (next && next.indent > indent) {
      const parsed = parseYamlMap(lines, cursor + 1, next.indent);
      Object.assign(item, parsed.value);
      cursor = parsed.index;
    } else {
      cursor += 1;
    }
    out.push(item);
  }
  return { value: out, index: cursor };
}

function parseYamlBlockScalar(
  lines: YamlLine[],
  index: number,
  parentIndent: number,
  marker: "|" | ">",
): { value: string; index: number } {
  const parts: string[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line || line.indent <= parentIndent) break;
    parts.push(line.content);
    cursor += 1;
  }
  return { value: marker === ">" ? parts.join(" ") : parts.join("\n"), index: cursor };
}

function splitYamlPair(content: string): [string, string] | undefined {
  const index = content.indexOf(":");
  if (index <= 0) return undefined;
  const key = unquoteYamlString(content.slice(0, index).trim());
  if (!key) return undefined;
  return [key, content.slice(index + 1)];
}

function parseYamlScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return parseInlineArray(value);
  return unquoteYamlString(value);
}

function parseInlineArray(value: string): unknown[] {
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((part) => parseYamlScalar(part.trim()));
}

function unquoteYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
