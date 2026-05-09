import { PgPool } from "../db/pool.js";
import { MemoryScope, MemorySensitivity, MemoryStatus, SkillMemoryEntry } from "../types.js";
import {
  applyMemoryVisibility as applyEntryMemoryVisibility,
  attachMemoryMatch,
  createMemoryId,
  matchMemoryEntry,
  MemoryListOptions,
  memoryRuntimeScore,
  MemoryUpdateInput,
  normalizeEntry,
  normalizeMemoryConfidence,
  normalizeMemoryScope,
  normalizeMemorySensitivity,
  normalizeMemoryStatus,
  SkillMemoryStore,
  tokenizeMemoryText,
} from "./skillMemory.js";
import {
  DeterministicTextEmbeddingProvider,
  formatPgVector,
  memoryEmbeddingText,
  TextEmbeddingProvider,
} from "./textEmbedding.js";

type SkillMemoryRow = {
  id: string;
  title: string;
  tags: string[];
  summary: string;
  reusable_procedure: string;
  scope: MemoryScope;
  scope_id: string | null;
  status: MemoryStatus;
  confidence: number;
  sensitivity: MemorySensitivity;
  source_run_id: string | null;
  source_thread_id: string | null;
  evidence: string[] | null;
  created_at: Date;
  updated_at: Date;
};

type RankedMemoryCandidate = {
  entry: SkillMemoryEntry;
  lexicalRank?: number;
  semanticRank?: number;
};

export class PostgresSkillMemory implements SkillMemoryStore {
  constructor(
    private readonly pool: PgPool,
    private readonly embeddingProvider: TextEmbeddingProvider = new DeterministicTextEmbeddingProvider(),
  ) {}

  async list(options: MemoryListOptions = {}): Promise<SkillMemoryEntry[]> {
    const filters: string[] = [];
    const values: unknown[] = [];

    if (!options.includeArchived) filters.push("status <> 'archived'");
    if (options.scope) {
      values.push(options.scope);
      filters.push(`scope = $${values.length}`);
    }
    if (options.scopeId) {
      values.push(options.scopeId);
      filters.push(`scope_id = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      filters.push(`status = $${values.length}`);
    }
    values.push(options.limit ?? 200);

    const rows = await this.pool.query<SkillMemoryRow>(
      `
        select ${memoryColumns}
        from skill_memories
        ${filters.length ? `where ${filters.join(" and ")}` : ""}
        order by updated_at desc, created_at desc
        limit $${values.length}
      `,
      values,
    );

    return rows.rows.map(mapRow);
  }

  async search(query: string, limit = 5, options: MemoryListOptions = {}): Promise<SkillMemoryEntry[]> {
    const queryTokens = tokenizeMemoryText(query);
    const status = options.status ?? "accepted";
    const filters = ["status = $2"];
    const values: unknown[] = [query];
    values.push(status);
    if (options.scope) {
      values.push(options.scope);
      filters.push(`scope = $${values.length}`);
    }
    if (options.scopeId) {
      values.push(options.scopeId);
      filters.push(`scope_id = $${values.length}`);
    }
    values.push(Math.max(limit * 4, 12));

    const lexical = await this.pool.query<SkillMemoryRow>(
      `
        select ${memoryColumns}
        from skill_memories
        where (${filters.join(" and ")})
          and (
            search_document @@ plainto_tsquery('simple', $1)
            or title ilike '%' || $1 || '%'
            or summary ilike '%' || $1 || '%'
          )
        order by ts_rank(search_document, plainto_tsquery('simple', $1)) desc, created_at desc
        limit $${values.length}
      `,
      values,
    );

    const semantic = await this.semanticSearch(query, Math.max(limit * 4, 12), options);
    const candidates = mergeMemoryCandidates(
      lexical.rows.map((row, index) => ({ entry: mapRow(row), lexicalRank: index + 1 })),
      semantic,
    );

    return applyRankedMemoryVisibility(candidates, options)
      .map((candidate) => {
        const match = matchMemoryEntry(candidate.entry, queryTokens);
        const lexicalRrf = candidate.lexicalRank ? 1 / (60 + candidate.lexicalRank) : 0;
        const semanticRrf = candidate.semanticRank ? 1 / (60 + candidate.semanticRank) : 0;
        const score = memoryRuntimeScore(candidate.entry, match, options) + lexicalRrf + semanticRrf;
        return { candidate, match, score };
      })
      .filter(({ match, candidate }) => match.score > 0 || candidate.lexicalRank !== undefined)
      .sort((a, b) => b.score - a.score || (b.candidate.entry.confidence ?? 0) - (a.candidate.entry.confidence ?? 0))
      .slice(0, limit)
      .map(({ candidate, match }) => attachMemoryMatch(candidate.entry, match));
  }

  async add(entry: Omit<SkillMemoryEntry, "id" | "createdAt">): Promise<SkillMemoryEntry> {
    const now = new Date().toISOString();
    const stored = normalizeEntry({
      ...entry,
      id: createMemoryId(entry.title),
      createdAt: now,
      updatedAt: now,
    });

    await this.pool.query(
      `
        insert into skill_memories (
          id, title, tags, summary, reusable_procedure, scope, scope_id, status, confidence,
          sensitivity, source_run_id, source_thread_id, evidence, created_at, updated_at,
          search_document, memory_embedding
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14,
          setweight(to_tsvector('simple', $2), 'A') ||
          setweight(to_tsvector('simple', $15), 'B') ||
          setweight(to_tsvector('simple', $4), 'B') ||
          setweight(to_tsvector('simple', $5), 'C') ||
          setweight(to_tsvector('simple', $16), 'C'),
          $17::vector)
        on conflict (id) do update
        set title = excluded.title,
            tags = excluded.tags,
            summary = excluded.summary,
            reusable_procedure = excluded.reusable_procedure,
            scope = excluded.scope,
            scope_id = excluded.scope_id,
            status = excluded.status,
            confidence = excluded.confidence,
            sensitivity = excluded.sensitivity,
            source_run_id = excluded.source_run_id,
            source_thread_id = excluded.source_thread_id,
            evidence = excluded.evidence,
            updated_at = excluded.updated_at,
            search_document = excluded.search_document,
            memory_embedding = excluded.memory_embedding
      `,
      [
        stored.id,
        stored.title,
        stored.tags,
        stored.summary,
        stored.reusableProcedure,
        stored.scope,
        stored.scopeId ?? null,
        stored.status,
        stored.confidence,
        stored.sourceRunId ?? null,
        stored.sourceThreadId ?? null,
        stored.evidence ?? [],
        stored.createdAt,
        stored.tags.join(" "),
        (stored.evidence ?? []).join(" "),
        formatPgVector(await this.embeddingProvider.embed(memoryEmbeddingText(stored))),
      ],
    );

    return stored;
  }

  async update(id: string, update: MemoryUpdateInput): Promise<SkillMemoryEntry> {
    const existing = await this.pool.query<SkillMemoryRow>(
      `select ${memoryColumns} from skill_memories where id = $1`,
      [id],
    );
    if (!existing.rows[0]) throw new Error(`Memory ${id} was not found`);

    const merged = normalizeEntry({
      ...mapRow(existing.rows[0]),
      ...update,
      tags: update.tags ? [...update.tags] : mapRow(existing.rows[0]).tags,
      evidence: update.evidence ? [...update.evidence] : mapRow(existing.rows[0]).evidence,
      updatedAt: new Date().toISOString(),
    });

    const rows = await this.pool.query<SkillMemoryRow>(
      `
        update skill_memories
        set title = $2,
            tags = $3,
            summary = $4,
            reusable_procedure = $5,
            scope = $6,
            scope_id = $7,
            status = $8,
            confidence = $9,
            sensitivity = $10,
            source_run_id = $11,
            source_thread_id = $12,
            evidence = $13,
            updated_at = $14,
            search_document = setweight(to_tsvector('simple', $2), 'A') ||
              setweight(to_tsvector('simple', $15), 'B') ||
              setweight(to_tsvector('simple', $4), 'B') ||
              setweight(to_tsvector('simple', $5), 'C') ||
              setweight(to_tsvector('simple', $16), 'C'),
            memory_embedding = $17::vector
        where id = $1
        returning ${memoryColumns}
      `,
      [
        id,
        merged.title,
        merged.tags,
        merged.summary,
        merged.reusableProcedure,
        normalizeMemoryScope(merged.scope),
        merged.scopeId ?? null,
        normalizeMemoryStatus(merged.status),
        normalizeMemoryConfidence(merged.confidence),
        normalizeMemorySensitivity(merged.sensitivity),
        merged.sourceRunId ?? null,
        merged.sourceThreadId ?? null,
        merged.evidence ?? [],
        merged.updatedAt,
        merged.tags.join(" "),
        (merged.evidence ?? []).join(" "),
        formatPgVector(await this.embeddingProvider.embed(memoryEmbeddingText(merged))),
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async reembedAll(): Promise<{ updated: number }> {
    const entries = await this.list({ includeArchived: true, limit: 10000 });

    for (const entry of entries) {
      await this.pool.query(
        `
          update skill_memories
          set memory_embedding = $2::vector
          where id = $1
        `,
        [entry.id, formatPgVector(await this.embeddingProvider.embed(memoryEmbeddingText(entry)))],
      );
    }

    return { updated: entries.length };
  }

  private async semanticSearch(query: string, limit: number, options: MemoryListOptions): Promise<RankedMemoryCandidate[]> {
    const status = options.status ?? "accepted";
    const filters = ["status = $2", "memory_embedding is not null"];
    const values: unknown[] = [formatPgVector(await this.embeddingProvider.embed(query))];
    values.push(status);
    if (options.scope) {
      values.push(options.scope);
      filters.push(`scope = $${values.length}`);
    }
    if (options.scopeId) {
      values.push(options.scopeId);
      filters.push(`scope_id = $${values.length}`);
    }
    values.push(limit);

    try {
      const rows = await this.pool.query<SkillMemoryRow>(
        `
          select ${memoryColumns}
          from skill_memories
          where ${filters.join(" and ")}
          order by memory_embedding <=> $1::vector asc, updated_at desc
          limit $${values.length}
        `,
        values,
      );
      return rows.rows.map((row, index) => ({ entry: mapRow(row), semanticRank: index + 1 }));
    } catch {
      return [];
    }
  }
}

function mergeMemoryCandidates(
  lexical: RankedMemoryCandidate[],
  semantic: RankedMemoryCandidate[],
): RankedMemoryCandidate[] {
  const seen = new Map<string, RankedMemoryCandidate>();
  const merged: RankedMemoryCandidate[] = [];
  for (const candidate of [...lexical, ...semantic]) {
    const existing = seen.get(candidate.entry.id);
    if (existing) {
      if (candidate.lexicalRank !== undefined) existing.lexicalRank = candidate.lexicalRank;
      if (candidate.semanticRank !== undefined) existing.semanticRank = candidate.semanticRank;
      continue;
    }
    const next = { ...candidate };
    seen.set(next.entry.id, next);
    merged.push(next);
  }
  return merged;
}

function applyRankedMemoryVisibility(
  candidates: RankedMemoryCandidate[],
  options: MemoryListOptions,
): RankedMemoryCandidate[] {
  const visible = candidates.map((candidate) => candidate.entry);
  const allowed = new Set(applyEntryMemoryVisibility(visible, options).map((entry) => entry.id));
  return candidates.filter((candidate) => allowed.has(candidate.entry.id));
}

const memoryColumns = `
  id, title, tags, summary, reusable_procedure, scope, scope_id, status, confidence,
  sensitivity, source_run_id, source_thread_id, evidence, created_at, updated_at
`;

function mapRow(row: SkillMemoryRow): SkillMemoryEntry {
  return {
    id: row.id,
    title: row.title,
    tags: row.tags,
    summary: row.summary,
    reusableProcedure: row.reusable_procedure,
    scope: row.scope,
    scopeId: row.scope_id ?? undefined,
    status: row.status,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    sourceRunId: row.source_run_id ?? undefined,
    sourceThreadId: row.source_thread_id ?? undefined,
    evidence: row.evidence ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
