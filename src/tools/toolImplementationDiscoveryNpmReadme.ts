import type { ToolAdapterContract, ToolBehaviorExample } from "./toolCreationStore.js";
import type { ToolSchema } from "./tool.js";

type NpmPackageMetadataResponse = {
  name?: unknown; description?: unknown; readme?: unknown; keywords?: unknown;
  "dist-tags"?: { latest?: unknown };
  versions?: Record<string, { main?: unknown; types?: unknown; module?: unknown; exports?: unknown }>;
};

export function summarizeNpmPackageMetadata(
  metadata: NpmPackageMetadataResponse,
  packageName: string,
  packageVersion: string | undefined,
  adapterContract: ToolAdapterContract | undefined,
  behaviorExamples: ToolBehaviorExample[] | undefined,
): string {
  const version = packageVersion ?? (typeof metadata["dist-tags"]?.latest === "string" ? metadata["dist-tags"].latest : undefined);
  const versionMeta = version ? metadata.versions?.[version] : undefined;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  const readme = typeof metadata.readme === "string" ? metadata.readme : "";
  const importHints = [
    readme.includes(`from '${packageName}'`) || readme.includes(`from "${packageName}"`) ? "ES module import shown" : undefined,
    readme.includes(`require('${packageName}')`) || readme.includes(`require("${packageName}")`) ? "CommonJS require shown" : undefined,
    readme.includes(`${packageName}(`) ? "callable usage shown" : undefined,
  ].filter(Boolean);
  const entryHints = [
    typeof versionMeta?.main === "string" ? `main=${versionMeta.main}` : undefined,
    typeof versionMeta?.module === "string" ? `module=${versionMeta.module}` : undefined,
    typeof versionMeta?.types === "string" ? `types=${versionMeta.types}` : undefined,
    versionMeta?.exports !== undefined ? "exports declared" : undefined,
  ].filter(Boolean);
  return [
    `${packageName}${version ? `@${version}` : ""} metadata inspected.`,
    description ? `Description: ${description.slice(0, 180)}.` : undefined,
    importHints.length ? `README hints: ${importHints.join(", ")}.` : undefined,
    entryHints.length ? `Package entries: ${entryHints.join(", ")}.` : undefined,
    adapterContract ? `Adapter contract: ${describeAdapterContract(adapterContract)}.` : undefined,
    behaviorExamples?.length ? `README behavior examples inferred: ${behaviorExamples.length}.` : undefined,
  ].filter(Boolean).join(" ");
}

export function inferAdapterContractFromReadme(readme: string, packageName: string): ToolAdapterContract | undefined {
  const packagePattern = escapeRegExp(packageName);
  const defaultImport = firstMatch(readme, new RegExp(`import\\s+(${IDENTIFIER})\\s+from\\s+['"]${packagePattern}['"]`));
  if (defaultImport && calledAsFunction(readme, defaultImport)) {
    const inputShape = inferInputShapeFromCall(readme, defaultImport);
    return {
      packageName,
      importStyle: "default",
      ...inputShape,
      evidence: adapterEvidence(
        `README imports default ${defaultImport} from ${packageName} and calls it as a function.`,
        inputShape,
      ),
    };
  }
  const defaultMember = defaultImport ? firstMatch(readme, new RegExp(`${escapeRegExp(defaultImport)}\\.(${IDENTIFIER})\\s*\\(`)) : undefined;
  if (defaultImport && defaultMember) {
    const callable = `${defaultImport}.${defaultMember}`;
    const inputShape = inferInputShapeFromCall(readme, callable);
    return {
      packageName,
      importStyle: "namespace",
      memberName: defaultMember,
      ...inputShape,
      evidence: adapterEvidence(
        `README imports default ${defaultImport} from ${packageName} and calls ${defaultImport}.${defaultMember}().`,
        inputShape,
      ),
    };
  }

  const namedImport = firstMatch(readme, new RegExp(`import\\s+\\{\\s*(${IDENTIFIER})(?:\\s+as\\s+${IDENTIFIER})?\\s*\\}\\s+from\\s+['"]${packagePattern}['"]`));
  if (namedImport && calledAsFunction(readme, namedImport)) {
    const inputShape = inferInputShapeFromCall(readme, namedImport);
    return {
      packageName,
      importStyle: "named",
      exportName: namedImport,
      ...inputShape,
      evidence: adapterEvidence(
        `README imports named export ${namedImport} from ${packageName} and calls it as a function.`,
        inputShape,
      ),
    };
  }

  const namespaceImport = firstMatch(readme, new RegExp(`import\\s+\\*\\s+as\\s+(${IDENTIFIER})\\s+from\\s+['"]${packagePattern}['"]`));
  const namespaceMember = namespaceImport ? firstMatch(readme, new RegExp(`${escapeRegExp(namespaceImport)}\\.(${IDENTIFIER})\\s*\\(`)) : undefined;
  if (namespaceImport && namespaceMember) {
    const callable = `${namespaceImport}.${namespaceMember}`;
    const inputShape = inferInputShapeFromCall(readme, callable);
    return {
      packageName,
      importStyle: "namespace",
      memberName: namespaceMember,
      ...inputShape,
      evidence: adapterEvidence(
        `README imports namespace ${namespaceImport} from ${packageName} and calls ${namespaceImport}.${namespaceMember}().`,
        inputShape,
      ),
    };
  }

  const commonJsDefault = firstMatch(readme, new RegExp(`(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*require\\(['"]${packagePattern}['"]\\)`));
  if (commonJsDefault && calledAsFunction(readme, commonJsDefault)) {
    const inputShape = inferInputShapeFromCall(readme, commonJsDefault);
    return {
      packageName,
      importStyle: "default",
      ...inputShape,
      evidence: adapterEvidence(
        `README requires ${packageName} into ${commonJsDefault} and calls it as a function.`,
        inputShape,
      ),
    };
  }
  const commonJsDefaultMember = commonJsDefault ? firstMatch(readme, new RegExp(`${escapeRegExp(commonJsDefault)}\\.(${IDENTIFIER})\\s*\\(`)) : undefined;
  if (commonJsDefault && commonJsDefaultMember) {
    const callable = `${commonJsDefault}.${commonJsDefaultMember}`;
    const inputShape = inferInputShapeFromCall(readme, callable);
    return {
      packageName,
      importStyle: "namespace",
      memberName: commonJsDefaultMember,
      ...inputShape,
      evidence: adapterEvidence(
        `README requires ${packageName} into ${commonJsDefault} and calls ${commonJsDefault}.${commonJsDefaultMember}().`,
        inputShape,
      ),
    };
  }

  const commonJsNamed = firstMatch(readme, new RegExp(`(?:const|let|var)\\s+\\{\\s*(${IDENTIFIER})\\s*\\}\\s*=\\s*require\\(['"]${packagePattern}['"]\\)`));
  if (commonJsNamed && calledAsFunction(readme, commonJsNamed)) {
    const inputShape = inferInputShapeFromCall(readme, commonJsNamed);
    return {
      packageName,
      importStyle: "named",
      exportName: commonJsNamed,
      ...inputShape,
      evidence: adapterEvidence(
        `README destructures ${commonJsNamed} from ${packageName} and calls it as a function.`,
        inputShape,
      ),
    };
  }

  return undefined;
}

export function inferBehaviorExamplesFromReadme(
  readme: string,
  packageName: string,
  adapterContract: ToolAdapterContract | undefined,
): ToolBehaviorExample[] | undefined {
  if (!adapterContract || !readme.trim()) return undefined;
  const examples: ToolBehaviorExample[] = [];
  for (const callable of adapterCallableNames(adapterContract, packageName)) {
    examples.push(...inferStringCallBehaviorExamples(readme, callable));
    examples.push(...inferObjectCallBehaviorExamples(readme, callable));
  }
  const deduped = dedupeBehaviorExamples(examples);
  return deduped.length > 0 ? deduped.slice(0, 3) : undefined;
}

function adapterCallableNames(contract: ToolAdapterContract, packageName: string): string[] {
  if (contract.importStyle === "named" && contract.exportName) return [contract.exportName];
  if (contract.importStyle === "namespace" && contract.memberName) {
    return [
      contract.memberName,
      `${packageIdentifier(packageName)}.${contract.memberName}`,
    ];
  }
  return [packageIdentifier(packageName), "tool", "fn"];
}

function inferStringCallBehaviorExamples(readme: string, callable: string): ToolBehaviorExample[] {
  const examples: ToolBehaviorExample[] = [];
  const pattern = new RegExp(
    `${escapeRegExp(callable)}\\s*\\(\\s*(['"\`])([^'"\`]{1,300})\\1(?:\\s*,\\s*(\\{[\\s\\S]{0,500}?\\}))?\\s*\\)\\s*\\)?\\s*(?://|=>|#|returns?\\s+)\\s*(['"\`]?)([^\\n\`]{1,200})`,
    "gi",
  );
  for (const match of readme.matchAll(pattern)) {
    const textInput = match[2]?.trim();
    const options = match[3] ? parseShallowObjectLiteral(match[3]) : {};
    const expected = cleanReadmeExpected(match[5] ?? "");
    if (!textInput || !expected) continue;
    examples.push({
      title: "README package example",
      input: { text: textInput, options },
      expectedOk: true,
      expectedContentIncludes: expected,
    });
  }
  return examples;
}

function inferObjectCallBehaviorExamples(readme: string, callable: string): ToolBehaviorExample[] {
  const examples: ToolBehaviorExample[] = [];
  const pattern = new RegExp(
    `${escapeRegExp(callable)}\\s*\\(\\s*(\\{[\\s\\S]{1,800}?\\})\\s*\\)\\s*\\)?\\s*(?://|=>|#|returns?\\s+)\\s*(['"\`]?)([^\\n\`]{1,200})`,
    "gi",
  );
  for (const match of readme.matchAll(pattern)) {
    const input = match[1] ? parseShallowObjectLiteral(match[1]) : {};
    const expected = cleanReadmeExpected(match[3] ?? "");
    if (Object.keys(input).length === 0 || !expected) continue;
    examples.push({
      title: "README package example",
      input,
      expectedOk: true,
      expectedContentIncludes: expected,
    });
  }
  return examples;
}

export function cleanReadmeExpected(value: string): string | undefined {
  const cleaned = value
    .replace(/```[\s\S]*$/g, "")
    .replace(/^[\s:=.'"`]+|[\s;.'"`,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 160) return undefined;
  if (/^(const|let|var|import|export)\b/.test(cleaned)) return undefined;
  return cleaned;
}

export function dedupeBehaviorExamples(examples: ToolBehaviorExample[]): ToolBehaviorExample[] {
  const seen = new Set<string>();
  const out: ToolBehaviorExample[] = [];
  for (const example of examples) {
    const key = JSON.stringify({
      input: example.input,
      expectedContent: example.expectedContent,
      expectedContentIncludes: example.expectedContentIncludes,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(example);
  }
  return out;
}

function packageIdentifier(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^(\d)/, "_$1");
}

function describeAdapterContract(contract: ToolAdapterContract): string {
  const input = contract.inputMode === "object" && contract.inputSchema?.required?.length
    ? ` with object input fields ${contract.inputSchema.required.join(", ")}`
    : "";
  if (contract.importStyle === "named") return `call named export ${contract.exportName}${input}`;
  if (contract.importStyle === "namespace") return `call namespace member ${contract.memberName}${input}`;
  return `call default export${input}`;
}

function calledAsFunction(text: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\s*\\(`).test(text);
}

function inferInputShapeFromCall(
  text: string,
  callable: string,
): Pick<ToolAdapterContract, "inputMode" | "inputSchema" | "inputExample"> {
  const objectLiteral = firstObjectLiteralArgument(text, callable);
  if (!objectLiteral) {
    return { inputMode: "text-options" };
  }
  const example = parseShallowObjectLiteral(objectLiteral);
  const keys = Object.keys(example);
  if (keys.length === 0) {
    return { inputMode: "text-options" };
  }
  const properties = Object.fromEntries(
    Object.entries(example).map(([key, value]) => [
      key,
      schemaForExampleValue(value),
    ]),
  );
  return {
    inputMode: "object",
    inputSchema: {
      type: "object",
      properties,
      required: keys,
    },
    inputExample: example,
  };
}

function firstObjectLiteralArgument(text: string, callable: string): string | undefined {
  const callPattern = new RegExp(`${escapeRegExp(callable)}\\s*\\(\\s*\\{`, "m");
  const match = callPattern.exec(text);
  if (!match) return undefined;
  const openBrace = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openBrace; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openBrace, index + 1);
    }
  }
  return undefined;
}

function parseShallowObjectLiteral(literal: string): Record<string, unknown> {
  const body = literal.trim().replace(/^\{/, "").replace(/\}$/, "");
  const result: Record<string, unknown> = {};
  for (const entry of splitTopLevel(body)) {
    const match = entry.match(/^\s*(?:['"]?([A-Za-z_$][A-Za-z0-9_$-]*)['"]?)\s*:\s*([\s\S]+?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key) continue;
    result[key] = parseExampleValue(rawValue ?? "");
  }
  return result;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseExampleValue(raw: string): unknown {
  const value = raw.trim().replace(/,$/, "");
  if (/^['"][\s\S]*['"]$/.test(value)) return value.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^\[[\s\S]*\]$/.test(value)) return [];
  if (/^\{[\s\S]*\}$/.test(value)) return {};
  return "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaForExampleValue(value: unknown): Record<string, unknown> {
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) return { type: "array" };
  if (value && typeof value === "object") return { type: "object" };
  return { type: "string" };
}

function adapterEvidence(
  base: string,
  inputShape: Pick<ToolAdapterContract, "inputMode" | "inputSchema">,
): string {
  if (inputShape.inputMode !== "object") return base;
  const fields = inputShape.inputSchema?.required ?? Object.keys(inputShape.inputSchema?.properties ?? {});
  return `${base} README call uses object input${fields.length ? ` with fields: ${fields.join(", ")}` : ""}.`;
}

function firstMatch(text: string, regex: RegExp): string | undefined {
  const match = text.match(regex);
  const value = match?.[1];
  return value && isIdentifier(value) ? value : undefined;
}

export function firstTextMatch(text: string, regex: RegExp, group = 1): string | undefined {
  const match = text.match(regex);
  const value = match?.[group];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isIdentifier(value: string): boolean {
  return new RegExp(`^${IDENTIFIER}$`).test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
