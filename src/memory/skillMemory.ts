import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SkillMemoryEntry } from "../types.js";

export class SkillMemory {
  constructor(private readonly filePath = "memory/skills.json") {}

  async list(): Promise<SkillMemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as SkillMemoryEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async search(query: string, limit = 5): Promise<SkillMemoryEntry[]> {
    const normalizedQuery = tokenize(query);
    const entries = await this.list();

    return entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, normalizedQuery),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  async add(entry: Omit<SkillMemoryEntry, "id" | "createdAt">): Promise<SkillMemoryEntry> {
    const entries = await this.list();
    const stored: SkillMemoryEntry = {
      ...entry,
      id: createId(entry.title),
      createdAt: new Date().toISOString(),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify([...entries, stored], null, 2)}\n`);

    return stored;
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
  const haystack = tokenize(
    `${entry.title} ${entry.tags.join(" ")} ${entry.summary} ${entry.reusableProcedure}`,
  );

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 1;
  }

  return score;
}

function createId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${slug || "skill"}-${Date.now()}`;
}
