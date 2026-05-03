import { PgPool } from "../db/pool.js";
import {
  ChannelIdentityRecord,
  ChannelIdentityStatus,
  normalizeProvider,
  ResolveUserInput,
  UserRecord,
  UserStore,
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

    if (input.sourceUserId && input.channel) {
      const identity = await this.pool.query<{ user_id: string }>(
        `
          select user_id
          from channel_identities
          where provider = $1
            and provider_user_id = $2
            and allow_status = 'allowed'
          limit 1
        `,
        [normalizeProvider(input.channel), input.sourceUserId],
      );
      const userId = identity.rows[0]?.user_id;
      return userId ? this.get(userId) : undefined;
    }

    return this.get(input.fallbackUserId ?? this.defaultUserId);
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
