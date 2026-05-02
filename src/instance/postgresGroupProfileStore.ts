import { PgPool } from "../db/pool.js";
import {
  compactProfileUpdate,
  GroupProfileRecord,
  GroupProfileStore,
  GroupProfileUpdateInput,
} from "./groupProfileStore.js";

type GroupProfileRow = {
  id: string;
  instance_id: string;
  name: string;
  description: string;
  preferences: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export class PostgresGroupProfileStore implements GroupProfileStore {
  constructor(private readonly pool: PgPool) {}

  async get(): Promise<GroupProfileRecord> {
    const rows = await this.pool.query<GroupProfileRow>(`
      select id, instance_id, name, description, preferences, created_at, updated_at
      from group_profile
      where id = 'group-local'
      limit 1
    `);

    if (!rows.rows[0]) {
      throw new Error("Group profile was not initialized");
    }

    return mapRow(rows.rows[0]);
  }

  async update(input: GroupProfileUpdateInput): Promise<GroupProfileRecord> {
    const update = compactProfileUpdate(input);
    const current = await this.get();
    const rows = await this.pool.query<GroupProfileRow>(
      `
        update group_profile
        set name = $1,
            description = $2,
            preferences = $3,
            updated_at = now()
        where id = 'group-local'
        returning id, instance_id, name, description, preferences, created_at, updated_at
      `,
      [
        update.name ?? current.name,
        update.description ?? current.description,
        update.preferences ?? current.preferences,
      ],
    );

    return mapRow(rows.rows[0] ?? current);
  }
}

function mapRow(row: GroupProfileRow): GroupProfileRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    name: row.name,
    description: row.description,
    preferences: row.preferences ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
