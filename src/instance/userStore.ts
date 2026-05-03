export type ChannelIdentityStatus = "allowed" | "blocked";

export type ChannelIdentityRecord = {
  id: string;
  provider: string;
  providerUserId: string;
  userId: string;
  allowStatus: ChannelIdentityStatus;
  displayMetadata: Record<string, unknown>;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserRecord = {
  id: string;
  displayName: string;
  role: string;
  roles: string[];
  identities: ChannelIdentityRecord[];
  createdAt: string;
  updatedAt: string;
};

export type UserCreateInput = {
  id?: string;
  displayName: string;
  role?: string;
  roles?: string[];
};

export type UserUpdateInput = {
  displayName?: string;
  role?: string;
  roles?: string[];
};

export type ChannelIdentityCreateInput = {
  id?: string;
  provider: string;
  providerUserId: string;
  userId: string;
  allowStatus?: ChannelIdentityStatus;
  displayMetadata?: Record<string, unknown>;
  lastSeenAt?: string;
};

export type ChannelIdentityUpdateInput = {
  allowStatus?: ChannelIdentityStatus;
  displayMetadata?: Record<string, unknown>;
  lastSeenAt?: string | null;
};

export type ResolveUserInput = {
  requesterUserId?: string;
  channel?: string;
  sourceUserId?: string;
  fallbackUserId?: string;
};

export type UserStore = {
  list(): Promise<UserRecord[]>;
  get(id: string): Promise<UserRecord | undefined>;
  resolve(input: ResolveUserInput): Promise<UserRecord | undefined>;
  create(input: UserCreateInput): Promise<UserRecord>;
  update(id: string, input: UserUpdateInput): Promise<UserRecord>;
  delete(id: string): Promise<boolean>;
  createIdentity(input: ChannelIdentityCreateInput): Promise<ChannelIdentityRecord>;
  updateIdentity(id: string, input: ChannelIdentityUpdateInput): Promise<ChannelIdentityRecord>;
  deleteIdentity(id: string): Promise<boolean>;
};

type UserSeed = {
  id: string;
  displayName: string;
  role?: string;
  roles?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type ChannelIdentitySeed = {
  id?: string;
  provider: string;
  providerUserId: string;
  userId: string;
  allowStatus?: ChannelIdentityStatus;
  displayMetadata?: Record<string, unknown>;
  lastSeenAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InMemoryUserStoreSeed = {
  defaultUserId?: string;
  users?: UserSeed[];
  identities?: ChannelIdentitySeed[];
};

const defaultDate = new Date(0).toISOString();
const defaultUserId = "user-admin";

export class InMemoryUserStore implements UserStore {
  private readonly defaultUserId: string;
  private readonly users = new Map<string, UserRecord>();

  constructor(seed: InMemoryUserStoreSeed = {}) {
    this.defaultUserId = seed.defaultUserId ?? defaultUserId;
    const users =
      seed.users ??
      [
        {
          id: defaultUserId,
          displayName: "Local Admin",
          role: "admin",
          roles: ["admin"],
        },
      ];
    const identities =
      seed.identities ??
      [
        {
          provider: "web",
          providerUserId: defaultUserId,
          userId: defaultUserId,
          allowStatus: "allowed",
        },
      ];

    for (const user of users) {
      const now = new Date().toISOString();
      this.users.set(user.id, {
        id: user.id,
        displayName: user.displayName,
        role: user.role ?? "member",
        roles: user.roles ?? [user.role ?? "member"],
        identities: [],
        createdAt: user.createdAt ?? now,
        updatedAt: user.updatedAt ?? now,
      });
    }

    for (const identity of identities) {
      const user = this.users.get(identity.userId);
      if (!user) continue;
      user.identities.push({
        id: identity.id ?? `${normalizeProvider(identity.provider)}:${identity.providerUserId}`,
        provider: normalizeProvider(identity.provider),
        providerUserId: identity.providerUserId,
        userId: identity.userId,
        allowStatus: identity.allowStatus ?? "allowed",
        displayMetadata: { ...(identity.displayMetadata ?? {}) },
        lastSeenAt: identity.lastSeenAt,
        createdAt: identity.createdAt ?? defaultDate,
        updatedAt: identity.updatedAt ?? defaultDate,
      });
    }
  }

  async list(): Promise<UserRecord[]> {
    return [...this.users.values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(cloneUser);
  }

  async get(id: string): Promise<UserRecord | undefined> {
    const user = this.users.get(id);
    return user ? cloneUser(user) : undefined;
  }

  async resolve(input: ResolveUserInput): Promise<UserRecord | undefined> {
    if (input.requesterUserId) return this.get(input.requesterUserId);

    if (input.sourceUserId && input.channel) {
      const provider = normalizeProvider(input.channel);
      for (const user of this.users.values()) {
        const identity = user.identities.find(
          (candidate) =>
            candidate.provider === provider &&
            candidate.providerUserId === input.sourceUserId &&
            candidate.allowStatus === "allowed",
        );
        if (identity) return cloneUser(user);
      }
      return undefined;
    }

    return this.get(input.fallbackUserId ?? this.defaultUserId);
  }

  async create(input: UserCreateInput): Promise<UserRecord> {
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("displayName is required");
    const id = input.id?.trim() || createUserId(displayName);
    if (this.users.has(id)) throw new Error(`User already exists: ${id}`);
    const now = new Date().toISOString();
    const roles = normalizeRoles(input.roles ?? [input.role ?? "member"]);
    const user: UserRecord = {
      id,
      displayName,
      role: input.role?.trim() || roles[0] || "member",
      roles,
      identities: [],
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, user);
    return cloneUser(user);
  }

  async update(id: string, input: UserUpdateInput): Promise<UserRecord> {
    const existing = this.users.get(id);
    if (!existing) throw new Error(`User was not found: ${id}`);
    const roles = input.roles ? normalizeRoles(input.roles) : existing.roles;
    const displayName = input.displayName?.trim() || existing.displayName;
    const role = input.role?.trim() || roles[0] || existing.role;
    const updated: UserRecord = {
      ...existing,
      displayName,
      role,
      roles,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return cloneUser(updated);
  }

  async delete(id: string): Promise<boolean> {
    if (id === this.defaultUserId) throw new Error("Default user cannot be deleted");
    return this.users.delete(id);
  }

  async createIdentity(input: ChannelIdentityCreateInput): Promise<ChannelIdentityRecord> {
    const user = this.users.get(input.userId);
    if (!user) throw new Error(`User was not found: ${input.userId}`);
    const provider = normalizeProvider(input.provider);
    const providerUserId = input.providerUserId.trim();
    if (!provider || !providerUserId) throw new Error("provider and providerUserId are required");
    for (const candidate of this.users.values()) {
      if (
        candidate.identities.some(
          (identity) => identity.provider === provider && identity.providerUserId === providerUserId,
        )
      ) {
        throw new Error(`Channel identity already exists: ${provider}/${providerUserId}`);
      }
    }
    const now = new Date().toISOString();
    const identity: ChannelIdentityRecord = {
      id: input.id?.trim() || `${provider}:${providerUserId}`,
      provider,
      providerUserId,
      userId: input.userId,
      allowStatus: input.allowStatus ?? "allowed",
      displayMetadata: { ...(input.displayMetadata ?? {}) },
      lastSeenAt: input.lastSeenAt,
      createdAt: now,
      updatedAt: now,
    };
    user.identities.push(identity);
    user.updatedAt = now;
    return { ...identity, displayMetadata: { ...identity.displayMetadata } };
  }

  async updateIdentity(id: string, input: ChannelIdentityUpdateInput): Promise<ChannelIdentityRecord> {
    const found = findIdentity(this.users, id);
    if (!found) throw new Error(`Channel identity was not found: ${id}`);
    const now = new Date().toISOString();
    const updated: ChannelIdentityRecord = {
      ...found.identity,
      allowStatus: input.allowStatus ?? found.identity.allowStatus,
      displayMetadata: input.displayMetadata ? { ...input.displayMetadata } : found.identity.displayMetadata,
      lastSeenAt: input.lastSeenAt === null ? undefined : input.lastSeenAt ?? found.identity.lastSeenAt,
      updatedAt: now,
    };
    found.user.identities[found.index] = updated;
    found.user.updatedAt = now;
    return { ...updated, displayMetadata: { ...updated.displayMetadata } };
  }

  async deleteIdentity(id: string): Promise<boolean> {
    const found = findIdentity(this.users, id);
    if (!found) return false;
    found.user.identities.splice(found.index, 1);
    found.user.updatedAt = new Date().toISOString();
    return true;
  }
}

export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function cloneUser(user: UserRecord): UserRecord {
  return {
    ...user,
    roles: [...user.roles],
    identities: user.identities.map((identity) => ({
      ...identity,
      displayMetadata: { ...identity.displayMetadata },
    })),
  };
}

function normalizeRoles(roles: string[]): string[] {
  const normalized = roles.map((role) => role.trim()).filter(Boolean);
  return [...new Set(normalized.length ? normalized : ["member"])];
}

function createUserId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `user-${slug || "member"}-${Date.now().toString(36)}`;
}

function findIdentity(users: Map<string, UserRecord>, id: string) {
  for (const user of users.values()) {
    const index = user.identities.findIndex((identity) => identity.id === id);
    if (index >= 0) return { user, identity: user.identities[index], index };
  }
  return undefined;
}
