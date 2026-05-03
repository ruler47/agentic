import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryScope,
  MemorySensitivity,
  MemoryStatus,
  SkillMemoryEntry,
  SkillMemoryMatch,
} from "../types.js";

export type MemoryScopeFilter = {
  scope: MemoryScope;
  scopeId?: string;
};

export type MemoryListOptions = {
  scope?: MemoryScope;
  scopeId?: string;
  visibleScopes?: MemoryScopeFilter[];
  status?: MemoryStatus;
  includeArchived?: boolean;
  limit?: number;
};

export type MemoryUpdateInput = Partial<
  Pick<
    SkillMemoryEntry,
    | "title"
    | "tags"
    | "summary"
    | "reusableProcedure"
    | "scope"
    | "scopeId"
    | "status"
    | "confidence"
    | "sensitivity"
    | "sourceRunId"
    | "sourceThreadId"
    | "evidence"
  >
>;

export type SkillMemoryStore = {
  list(options?: MemoryListOptions): Promise<SkillMemoryEntry[]>;
  search(query: string, limit?: number, options?: MemoryListOptions): Promise<SkillMemoryEntry[]>;
  add(entry: Omit<SkillMemoryEntry, "id" | "createdAt">): Promise<SkillMemoryEntry>;
  update?(id: string, update: MemoryUpdateInput): Promise<SkillMemoryEntry>;
  reembedAll?(): Promise<{ updated: number }>;
};

export class SkillMemory implements SkillMemoryStore {
  constructor(private readonly filePath = "memory/skills.json") {}

  async list(options: MemoryListOptions = {}): Promise<SkillMemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return applyMemoryListOptions((JSON.parse(raw) as SkillMemoryEntry[]).map(normalizeEntry), options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async search(query: string, limit = 5, options: MemoryListOptions = {}): Promise<SkillMemoryEntry[]> {
    const normalizedQuery = tokenize(query);
    const entries = applyMemoryVisibility(
      await this.list({ ...options, status: options.status ?? "accepted", limit: undefined }),
      options,
    );

    return entries
      .map((entry) => ({
        entry,
        match: matchEntry(entry, normalizedQuery),
      }))
      .filter(({ match }) => match.score > 0)
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, limit)
      .map(({ entry, match }) => attachMemoryMatch(entry, match));
  }

  async add(entry: Omit<SkillMemoryEntry, "id" | "createdAt">): Promise<SkillMemoryEntry> {
    const entries = await this.readAll();
    const now = new Date().toISOString();
    const stored = normalizeEntry({
      ...entry,
      id: createId(entry.title),
      createdAt: now,
      updatedAt: now,
    });

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify([...entries, stored], null, 2)}\n`);

    return stored;
  }

  async update(id: string, update: MemoryUpdateInput): Promise<SkillMemoryEntry> {
    const entries = await this.readAll();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`Memory ${id} was not found`);

    const updated = normalizeEntry({
      ...entries[index],
      ...update,
      tags: update.tags ? [...update.tags] : entries[index].tags,
      evidence: update.evidence ? [...update.evidence] : entries[index].evidence,
      updatedAt: new Date().toISOString(),
    });
    entries[index] = updated;

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(entries, null, 2)}\n`);

    return updated;
  }

  private async readAll(): Promise<SkillMemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return (JSON.parse(raw) as SkillMemoryEntry[]).map(normalizeEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/i)
      .filter((token) => token.length > 2),
  );
}

function scoreEntry(entry: SkillMemoryEntry, queryTokens: Set<string>): number {
  return matchEntry(entry, queryTokens).score;
}

function matchEntry(entry: SkillMemoryEntry, queryTokens: Set<string>): SkillMemoryMatch {
  const haystack = tokenize(
    `${entry.title} ${entry.tags.join(" ")} ${entry.summary} ${entry.reusableProcedure} ${(entry.evidence ?? []).join(" ")}`,
  );
  const matchedTokens: string[] = [];

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
      matchedTokens.push(token);
    }
  }

  const confidence = normalizeMemoryConfidence(entry.confidence);
  const confidenceBoost = score > 0 ? confidence : 0;
  const finalScore = Number((score + confidenceBoost).toFixed(3));
  const scope = normalizeMemoryScope(entry.scope);

  return {
    score: finalScore,
    matchedTokens,
    scope,
    scopeId: entry.scopeId,
    reason: matchedTokens.length
      ? `Matched ${matchedTokens.length} token(s): ${matchedTokens.slice(0, 8).join(", ")}. Confidence ${Math.round(confidence * 100)}%.`
      : `No lexical overlap. Confidence ${Math.round(confidence * 100)}%.`,
  };
}

function createId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${slug || "skill"}-${Date.now()}`;
}

export function applyMemoryListOptions(
  entries: SkillMemoryEntry[],
  options: MemoryListOptions = {},
): SkillMemoryEntry[] {
  return entries
    .map(normalizeEntry)
    .filter((entry) => (options.includeArchived ? true : entry.status !== "archived"))
    .filter((entry) => (options.scope ? entry.scope === options.scope : true))
    .filter((entry) => (options.scopeId ? entry.scopeId === options.scopeId : true))
    .filter((entry) => (options.status ? entry.status === options.status : true))
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    .slice(0, options.limit ?? 200);
}

export function applyMemoryVisibility(
  entries: SkillMemoryEntry[],
  options: MemoryListOptions = {},
): SkillMemoryEntry[] {
  if (!options.visibleScopes?.length) return entries;
  return entries.filter((entry) => isMemoryVisible(entry, options.visibleScopes ?? []));
}

export function isMemoryVisible(entry: SkillMemoryEntry, visibleScopes: MemoryScopeFilter[]): boolean {
  const scope = normalizeMemoryScope(entry.scope);
  return visibleScopes.some((candidate) => {
    if (candidate.scope !== scope) return false;
    if (scope === "global") return true;
    return Boolean(candidate.scopeId) && candidate.scopeId === entry.scopeId;
  });
}

export function normalizeMemoryScope(scope: unknown): MemoryScope {
  return scope === "group" || scope === "user" || scope === "thread" || scope === "run"
    ? scope
    : "global";
}

export function normalizeMemoryStatus(status: unknown): MemoryStatus {
  return status === "proposed" || status === "rejected" || status === "archived"
    ? status
    : "accepted";
}

export function normalizeMemorySensitivity(sensitivity: unknown): MemorySensitivity {
  return sensitivity === "sensitive" || sensitivity === "private" ? sensitivity : "normal";
}

export function normalizeMemoryConfidence(confidence: unknown): number {
  const value = typeof confidence === "number" ? confidence : Number(confidence ?? 0.75);
  if (!Number.isFinite(value)) return 0.75;
  return Math.max(0, Math.min(1, value));
}

export function normalizeEntry(entry: SkillMemoryEntry): SkillMemoryEntry {
  return {
    ...entry,
    tags: [...(entry.tags ?? [])],
    evidence: entry.evidence ? [...entry.evidence] : [],
    scope: normalizeMemoryScope(entry.scope),
    status: normalizeMemoryStatus(entry.status),
    confidence: normalizeMemoryConfidence(entry.confidence),
    sensitivity: normalizeMemorySensitivity(entry.sensitivity),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt ?? entry.createdAt,
  };
}

export function tokenizeMemoryText(text: string): Set<string> {
  return tokenize(text);
}

export function scoreMemoryEntry(entry: SkillMemoryEntry, queryTokens: Set<string>): number {
  return scoreEntry(entry, queryTokens);
}

export function matchMemoryEntry(entry: SkillMemoryEntry, queryTokens: Set<string>): SkillMemoryMatch {
  return matchEntry(entry, queryTokens);
}

export function attachMemoryMatch(entry: SkillMemoryEntry, match: SkillMemoryMatch): SkillMemoryEntry {
  return { ...entry, match };
}

export function createMemoryId(title: string): string {
  return createId(title);
}
