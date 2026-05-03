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
