import { PgPool } from "../db/pool.js";
import { SkillMemoryEntry } from "../types.js";
import {
  createMemoryId,
  scoreMemoryEntry,
  SkillMemoryStore,
  tokenizeMemoryText,
} from "./skillMemory.js";

type SkillMemoryRow = {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  reusable_procedure: string;
  created_at: Date;
};

export class PostgresSkillMemory implements SkillMemoryStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<SkillMemoryEntry[]> {
    const rows = await this.pool.query<SkillMemoryRow>(`
      select id, title, tags, summary, reusable_procedure, created_at
      from skill_memories
      order by created_at desc
      limit 200
    `);

    return rows.rows.map(mapRow);
  }

  async search(query: string, limit = 5): Promise<SkillMemoryEntry[]> {
    const queryTokens = tokenizeMemoryText(query);
    const lexical = await this.pool.query<SkillMemoryRow>(
      `
        select id, title, tags, summary, reusable_procedure, created_at
        from skill_memories
        where search_document @@ plainto_tsquery('simple', $1)
           or title ilike '%' || $1 || '%'
           or summary ilike '%' || $1 || '%'
        order by ts_rank(search_document, plainto_tsquery('simple', $1)) desc, created_at desc
        limit $2
      `,
      [query, Math.max(limit * 4, 12)],
    );

    const candidates = lexical.rows.length > 0 ? lexical.rows.map(mapRow) : await this.list();

    return candidates
      .map((entry) => ({ entry, score: scoreMemoryEntry(entry, queryTokens) }))
      .filter(({ score }, index) => score > 0 || lexical.rows.length > 0 || index < limit)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  async add(entry: Omit<SkillMemoryEntry, "id" | "createdAt">): Promise<SkillMemoryEntry> {
    const stored: SkillMemoryEntry = {
      ...entry,
      id: createMemoryId(entry.title),
      createdAt: new Date().toISOString(),
    };

    await this.pool.query(
      `
        insert into skill_memories (
          id, title, tags, summary, reusable_procedure, created_at, search_document
        )
        values ($1, $2, $3, $4, $5, $6, setweight(to_tsvector('simple', $2), 'A') ||
          setweight(to_tsvector('simple', $7), 'B') ||
          setweight(to_tsvector('simple', $4), 'B') ||
          setweight(to_tsvector('simple', $5), 'C'))
        on conflict (id) do update
        set title = excluded.title,
            tags = excluded.tags,
            summary = excluded.summary,
            reusable_procedure = excluded.reusable_procedure,
            search_document = excluded.search_document
      `,
      [
        stored.id,
        stored.title,
        stored.tags,
        stored.summary,
        stored.reusableProcedure,
        stored.createdAt,
        stored.tags.join(" "),
      ],
    );

    return stored;
  }
}

function mapRow(row: SkillMemoryRow): SkillMemoryEntry {
  return {
    id: row.id,
    title: row.title,
    tags: row.tags,
    summary: row.summary,
    reusableProcedure: row.reusable_procedure,
    createdAt: row.created_at.toISOString(),
  };
}
