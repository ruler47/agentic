import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Phase 12 Slice E: domain-specific URL whitelists must NOT live in the
 * universal agent runtime. They belong on tool contracts
 * (`Tool.evidencePatterns`), in built-in seed data
 * (`src/tools/builtinEvidencePatterns.ts`), or in scoped memory entries
 * parsed via `evidencePatternMemory.ts`.
 *
 * This test fails the build if any source file under `src/agents/` (the
 * universal-runtime surface) names a specific flight aggregator or medical
 * directory host. The `intentInference.ts` placeholder is the documented
 * exception while we wait for the LLM-driven `ClassificationResult.intent[]`
 * field — when that ships, the regex inside `intentInference.ts` deletes in
 * one shot and this allowlist shrinks to empty.
 */

const AGENTS_DIR = resolve(__dirname, "..", "src", "agents");

const BANNED_HOST_TOKENS = [
  // Flight aggregators / carriers
  "skyscanner",
  "kayak",
  "momondo",
  "expedia",
  "aviasales",
  "ryanair",
  "easyjet",
  "vueling",
  "lufthansa",
  "turkishairlines",
  "pegasus",
  // Medical / doctor portals
  "doctolib",
  "jameda",
  "onedoc",
  "topdoctors",
  "sanego",
  "miodottore",
  "doctoralia",
];

const ALLOWED_FILES = new Set<string>([
  // Documented placeholder for the LLM-driven intent classifier (Slice A
  // full plan); regex stays here until the classifier ships.
  "intentInference.ts",
]);

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

test("banned domain tokens do not appear in src/agents/*.ts (Phase 12 Slice E)", async () => {
  const files = await listTsFiles(AGENTS_DIR);
  const violations: Array<{ file: string; line: number; token: string; preview: string }> = [];

  for (const file of files) {
    const fileName = file.split("/").pop() ?? file;
    if (ALLOWED_FILES.has(fileName)) continue;
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      for (const token of BANNED_HOST_TOKENS) {
        if (lower.includes(token)) {
          violations.push({
            file: file.replace(`${AGENTS_DIR}/`, ""),
            line: i + 1,
            token,
            preview: line.trim().slice(0, 200),
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    const report = violations
      .slice(0, 20)
      .map((v) => `  ${v.file}:${v.line} contains "${v.token}"\n    ${v.preview}`)
      .join("\n");
    assert.fail(
      `Domain-specific URL whitelist tokens leaked into src/agents/. ` +
        `Move them onto a tool's evidencePatterns array or into a scoped memory entry.\n` +
        `(${violations.length} violation(s); see Phase 12 Slice E in docs/roadmap.md.)\n${report}`,
    );
  }
});

test("intentInference.ts exports the documented helpers", async () => {
  const file = join(AGENTS_DIR, "intentInference.ts");
  const text = await readFile(file, "utf8");
  for (const symbol of [
    "inferTaskIntents",
    "isDiscoveryText",
    "wantsInteractiveSource",
    "expandSearchQueriesByIntent",
    "extractIntentSourceHints",
    "KNOWN_INTENTS",
  ]) {
    assert.match(text, new RegExp(`export (?:function|const) ${symbol}`),
      `intentInference.ts must export ${symbol}`);
  }
});

test("intentInference.ts contains no domain-specific regex", async () => {
  const file = join(AGENTS_DIR, "intentInference.ts");
  const text = await readFile(file, "utf8");
  // Phase 12 final: `inferTaskIntents` is a compatibility shim that always
  // returns []. The runtime reads classifier-resolved intents via
  // `runScopedIntents`. If a contributor adds a regex with specific
  // aggregator / portal tokens here they fail this guard.
  for (const token of [
    "skyscanner", "kayak", "momondo", "expedia", "doctolib", "jameda",
    "aviasales", "ryanair", "easyjet", "topdoctors", "onedoc",
  ]) {
    assert.equal(
      text.toLowerCase().includes(token),
      false,
      `intentInference.ts must not name "${token}" — domain knowledge belongs on tools / memory / LLM ranker.`,
    );
  }
});

test("builtinEvidencePatterns.ts ships an empty seed", async () => {
  const file = resolve(__dirname, "..", "src", "tools", "builtinEvidencePatterns.ts");
  const text = await readFile(file, "utf8");
  // Phase 12 final: the runtime carries no built-in domain knowledge.
  // Patterns arrive through tool contracts, scoped memory, or the LLM
  // URL ranker.
  assert.match(text, /BUILTIN_EVIDENCE_PATTERNS:\s*EvidencePattern\[\]\s*=\s*\[\]\s*;/, "BUILTIN_EVIDENCE_PATTERNS must be exported as an empty array");
  for (const token of [
    "skyscanner", "kayak", "momondo", "expedia", "aviasales",
    "doctolib", "jameda", "onedoc", "topdoctors", "doctoralia",
  ]) {
    assert.equal(
      text.toLowerCase().includes(token),
      false,
      `builtinEvidencePatterns.ts must not contain "${token}" — even in comments — to keep the file domain-neutral.`,
    );
  }
});
