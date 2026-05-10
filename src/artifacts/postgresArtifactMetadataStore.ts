import { Pool } from "pg";
import { AgentArtifact, AgentArtifactKind, ArtifactQualityMetadata } from "../types.js";
import { ArtifactMetadataRecord, ArtifactMetadataStore } from "./artifactStore.js";

type ArtifactRow = {
  id: string;
  run_id: string;
  kind: AgentArtifactKind;
  filename: string;
  mime_type: string;
  size_bytes: string | number;
  url: string;
  description: string | null;
  content_preview: string | null;
  quality: ArtifactQualityMetadata | null;
  storage_provider: string;
  object_key: string;
  checksum_sha256: string;
  created_at: Date;
};

export class PostgresArtifactMetadataStore implements ArtifactMetadataStore {
  constructor(private readonly pool: Pool) {}

  async save(record: ArtifactMetadataRecord): Promise<AgentArtifact> {
    await this.pool.query(
      `
        insert into artifacts (
          id,
          run_id,
          kind,
          filename,
          mime_type,
          size_bytes,
          url,
          description,
          content_preview,
          quality,
          storage_provider,
          object_key,
          checksum_sha256,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
        on conflict (id) do update set
          run_id = excluded.run_id,
          kind = excluded.kind,
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          url = excluded.url,
          description = excluded.description,
          content_preview = excluded.content_preview,
          quality = excluded.quality,
          storage_provider = excluded.storage_provider,
          object_key = excluded.object_key,
          checksum_sha256 = excluded.checksum_sha256
      `,
      [
        record.artifact.id,
        record.artifact.runId,
        record.artifact.kind,
        record.artifact.filename,
        record.artifact.mimeType,
        record.artifact.sizeBytes,
        record.artifact.url,
        record.artifact.description ?? null,
        record.artifact.contentPreview ?? null,
        record.artifact.quality ? JSON.stringify(record.artifact.quality) : null,
        record.storageProvider,
        record.objectKey,
        record.checksumSha256,
        record.artifact.createdAt,
      ],
    );

    return record.artifact;
  }

  async list(runId: string): Promise<AgentArtifact[]> {
    const result = await this.pool.query<ArtifactRow>(
      `
        select *
        from artifacts
        where run_id = $1
        order by created_at asc
      `,
      [runId],
    );
    return result.rows.map((row) => mapArtifactRow(row).artifact);
  }

  async get(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `
        select *
        from artifacts
        where run_id = $1 and id = $2
        limit 1
      `,
      [runId, artifactId],
    );
    return result.rows[0] ? mapArtifactRow(result.rows[0]) : undefined;
  }

  async delete(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `
        delete from artifacts
        where run_id = $1 and id = $2
        returning *
      `,
      [runId, artifactId],
    );
    return result.rows[0] ? mapArtifactRow(result.rows[0]) : undefined;
  }
}

function mapArtifactRow(row: ArtifactRow): ArtifactMetadataRecord {
  return {
    artifact: {
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      url: row.url,
      description: row.description ?? undefined,
      contentPreview: row.content_preview ?? undefined,
      quality: row.quality ?? undefined,
      createdAt: row.created_at.toISOString(),
    },
    storageProvider: row.storage_provider,
    objectKey: row.object_key,
    checksumSha256: row.checksum_sha256,
  };
}
