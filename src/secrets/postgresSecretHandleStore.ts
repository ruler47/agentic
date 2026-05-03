import { PgPool } from "../db/pool.js";
import {
  normalizeSecretHandleInput,
  SecretHandleInput,
  SecretHandleProvider,
  SecretHandleRecord,
  SecretHandleStore,
} from "./secretHandleStore.js";

type SecretHandleRow = {
  handle: string;
  label: string;
  provider: SecretHandleProvider;
  secret_ref: string;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
};

export class PostgresSecretHandleStore implements SecretHandleStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: SecretHandleInput): Promise<SecretHandleRecord> {
    const normalized = normalizeSecretHandleInput(input);
    const now = new Date().toISOString();
    const rows = await this.pool.query<SecretHandleRow>(
      `
        insert into secret_handles (handle, label, provider, secret_ref, scopes, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $6)
        on conflict (handle) do update
        set label = excluded.label,
            provider = excluded.provider,
            secret_ref = excluded.secret_ref,
            scopes = excluded.scopes,
            updated_at = excluded.updated_at
        returning handle, label, provider, secret_ref, scopes, created_at, updated_at
      `,
      [
        normalized.handle,
        normalized.label,
        normalized.provider,
        normalized.secretRef,
        normalized.scopes,
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async get(handle: string): Promise<SecretHandleRecord | undefined> {
    const rows = await this.pool.query<SecretHandleRow>(
      `
        select handle, label, provider, secret_ref, scopes, created_at, updated_at
        from secret_handles
        where handle = $1
      `,
      [handle],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async list(limit = 100): Promise<SecretHandleRecord[]> {
    const rows = await this.pool.query<SecretHandleRow>(
      `
        select handle, label, provider, secret_ref, scopes, created_at, updated_at
        from secret_handles
        order by updated_at desc
        limit $1
      `,
      [limit],
    );
    return rows.rows.map(mapRow);
  }

  async delete(handle: string): Promise<boolean> {
    const result = await this.pool.query("delete from secret_handles where handle = $1", [handle]);
    return (result.rowCount ?? 0) > 0;
  }

  async resolve(handle: string): Promise<string | undefined> {
    const record = await this.get(handle);
    if (!record) return undefined;
    if (record.provider === "inline") return record.secretRef;
    if (record.provider !== "env") return undefined;
    return process.env[record.secretRef];
  }
}

function mapRow(row: SecretHandleRow | undefined): SecretHandleRecord {
  if (!row) {
    throw new Error("Secret handle write did not return a row");
  }
  return {
    handle: row.handle,
    label: row.label,
    provider: row.provider,
    secretRef: row.secret_ref,
    scopes: row.scopes ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
