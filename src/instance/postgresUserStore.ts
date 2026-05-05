import { PgPool } from "../db/pool.js";
import {
  ChannelIdentityCreateInput,
  ChannelIdentityRecord,
  ChannelIdentityStatus,
  ChannelIdentityUpdateInput,
  normalizeProvider,
  ResolveUserInput,
  UserCreateInput,
  UserRecord,
  UserStore,
  UserUpdateInput,
} from "./userStore.js";

type UserRow = {
  id: string;
  display_name: string;
  role: string;
  created_at: Date;
  updated_at: Date;
};

type RoleRow = {
  user_id: string;
  role: string;
};

type IdentityRow = {
  id: string;
  provider: string;
  provider_user_id: string;
  user_id: string;
  allow_status: ChannelIdentityStatus;
  display_metadata: Record<string, unknown>;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresUserStore implements UserStore {
  constructor(
    private readonly pool: PgPool,
    private readonly defaultUserId = "user-admin",
  ) {}

  async list(): Promise<UserRecord[]> {
    const users = await this.pool.query<UserRow>(`
      select id, display_name, role, created_at, updated_at
      from users
      order by display_name asc
    `);
    const userIds = users.rows.map((user) => user.id);
    return this.hydrateUsers(users.rows, userIds);
  }

  async get(id: string): Promise<UserRecord | undefined> {
    const users = await this.pool.query<UserRow>(
      `
        select id, display_name, role, created_at, updated_at
        from users
        where id = $1
        limit 1
      `,
      [id],
    );
    const hydrated = await this.hydrateUsers(users.rows, [id]);
    return hydrated[0];
  }

  async resolve(input: ResolveUserInput): Promise<UserRecord | undefined> {
    if (input.requesterUserId) return this.get(input.requesterUserId);

    if ((input.sourceUserId || input.sourceUserAliases?.length) && input.channel) {
      const sourceIds = uniqueIdentityIds([
        input.sourceUserId,
        ...(input.sourceUserAliases ?? []),
      ]);
      if (sourceIds.length === 0) return undefined;
      const identity = await this.pool.query<{ user_id: string }>(
        `
          select user_id
          from channel_identities
          where provider = $1
            and provider_user_id = any($2::text[])
            and allow_status = 'allowed'
          limit 1
        `,
        [normalizeProvider(input.channel), sourceIds],
      );
      const userId = identity.rows[0]?.user_id;
      return userId ? this.get(userId) : undefined;
    }

    return this.get(input.fallbackUserId ?? this.defaultUserId);
  }

  async create(input: UserCreateInput): Promise<UserRecord> {
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("displayName is required");
    const id = input.id?.trim() || createUserId(displayName);
    const roles = normalizeRoles(input.roles ?? [input.role ?? "member"]);
    const role = input.role?.trim() || roles[0] || "member";
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          insert into users (id, display_name, role, created_at, updated_at)
          values ($1, $2, $3, now(), now())
        `,
        [id, displayName, role],
      );
      for (const nextRole of roles) {
        await client.query(
          `
            insert into user_roles (user_id, role, created_at)
            values ($1, $2, now())
            on conflict (user_id, role) do nothing
          `,
          [id, nextRole],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const user = await this.get(id);
    if (!user) throw new Error(`User was not found after create: ${id}`);
    return user;
  }

  async update(id: string, input: UserUpdateInput): Promise<UserRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`User was not found: ${id}`);
    const roles = input.roles ? normalizeRoles(input.roles) : existing.roles;
    const role = input.role?.trim() || roles[0] || existing.role;
    const displayName = input.displayName?.trim() || existing.displayName;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          update users
          set display_name = $2,
              role = $3,
              updated_at = now()
          where id = $1
        `,
        [id, displayName, role],
      );
      await client.query(`delete from user_roles where user_id = $1`, [id]);
      for (const nextRole of roles) {
        await client.query(
          `
            insert into user_roles (user_id, role, created_at)
            values ($1, $2, now())
          `,
          [id, nextRole],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const updated = await this.get(id);
    if (!updated) throw new Error(`User was not found after update: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (id === this.defaultUserId) throw new Error("Default user cannot be deleted");
    const result = await this.pool.query(`delete from users where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createIdentity(input: ChannelIdentityCreateInput): Promise<ChannelIdentityRecord> {
    const user = await this.get(input.userId);
    if (!user) throw new Error(`User was not found: ${input.userId}`);
    const provider = normalizeProvider(input.provider);
    const providerUserId = input.providerUserId.trim();
    if (!provider || !providerUserId) throw new Error("provider and providerUserId are required");
    const id = input.id?.trim() || `${provider}:${providerUserId}`;
    const inserted = await this.pool.query<IdentityRow>(
      `
        insert into channel_identities (
          id,
          provider,
          provider_user_id,
          user_id,
          allow_status,
          display_metadata,
          last_seen_at,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now(), now())
        returning id, provider, provider_user_id, user_id, allow_status, display_metadata, last_seen_at, created_at, updated_at
      `,
      [
        id,
        provider,
        providerUserId,
        input.userId,
        input.allowStatus ?? "allowed",
        input.displayMetadata ?? {},
        input.lastSeenAt ?? null,
      ],
    );
    return mapIdentityRow(inserted.rows[0]!);
  }

  async updateIdentity(id: string, input: ChannelIdentityUpdateInput): Promise<ChannelIdentityRecord> {
    const existing = await this.pool.query<IdentityRow>(
      `
        select id,
               provider,
               provider_user_id,
               user_id,
               allow_status,
               display_metadata,
               last_seen_at,
               created_at,
               updated_at
        from channel_identities
        where id = $1
        limit 1
      `,
      [id],
    );
    const current = existing.rows[0];
    if (!current) throw new Error(`Channel identity was not found: ${id}`);
    const updated = await this.pool.query<IdentityRow>(
      `
        update channel_identities
        set allow_status = $2,
            display_metadata = $3,
            last_seen_at = $4,
            updated_at = now()
        where id = $1
        returning id, provider, provider_user_id, user_id, allow_status, display_metadata, last_seen_at, created_at, updated_at
      `,
      [
        id,
        input.allowStatus ?? current.allow_status,
        input.displayMetadata ?? current.display_metadata ?? {},
        input.lastSeenAt === null ? null : input.lastSeenAt ?? current.last_seen_at,
      ],
    );
    return mapIdentityRow(updated.rows[0]!);
  }

  async deleteIdentity(id: string): Promise<boolean> {
    const result = await this.pool.query(`delete from channel_identities where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private async hydrateUsers(rows: UserRow[], userIds: string[]): Promise<UserRecord[]> {
    if (rows.length === 0) return [];

    const roles = await this.pool.query<RoleRow>(
      `
        select user_id, role
        from user_roles
        where user_id = any($1)
        order by role asc
      `,
      [userIds],
    );
    const identities = await this.pool.query<IdentityRow>(
      `
        select id,
               provider,
               provider_user_id,
               user_id,
               allow_status,
               display_metadata,
               last_seen_at,
               created_at,
               updated_at
        from channel_identities
        where user_id = any($1)
        order by provider asc, provider_user_id asc
      `,
      [userIds],
    );

    return rows.map((row) => mapUserRow(row, roles.rows, identities.rows));
  }
}

function normalizeRoles(roles: string[]): string[] {
  const normalized = roles.map((role) => role.trim()).filter(Boolean);
  return [...new Set(normalized.length ? normalized : ["member"])];
}

function uniqueIdentityIds(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function createUserId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `user-${slug || "member"}-${Date.now().toString(36)}`;
}

function mapUserRow(row: UserRow, roles: RoleRow[], identities: IdentityRow[]): UserRecord {
  const userRoles = roles
    .filter((role) => role.user_id === row.id)
    .map((role) => role.role);

  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    roles: userRoles.length > 0 ? userRoles : [row.role],
    identities: identities
      .filter((identity) => identity.user_id === row.id)
      .map(mapIdentityRow),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapIdentityRow(row: IdentityRow): ChannelIdentityRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    userId: row.user_id,
    allowStatus: row.allow_status,
    displayMetadata: row.display_metadata ?? {},
    lastSeenAt: row.last_seen_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
