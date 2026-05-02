export type GroupProfileRecord = {
  id: string;
  instanceId: string;
  name: string;
  description: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GroupProfileUpdateInput = {
  name?: string;
  description?: string;
  preferences?: Record<string, unknown>;
};

export type GroupProfileStore = {
  get(): Promise<GroupProfileRecord>;
  update(input: GroupProfileUpdateInput): Promise<GroupProfileRecord>;
};

const defaultGroupProfile: GroupProfileRecord = {
  id: "group-local",
  instanceId: "instance-local",
  name: "Local Group Profile",
  description: "Default one-group profile for local development.",
  preferences: {},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

export class InMemoryGroupProfileStore implements GroupProfileStore {
  private profile: GroupProfileRecord;

  constructor(initialProfile: Partial<GroupProfileRecord> = {}) {
    const now = new Date().toISOString();
    this.profile = {
      ...defaultGroupProfile,
      ...initialProfile,
      preferences: { ...(initialProfile.preferences ?? defaultGroupProfile.preferences) },
      createdAt: initialProfile.createdAt ?? now,
      updatedAt: initialProfile.updatedAt ?? now,
    };
  }

  async get(): Promise<GroupProfileRecord> {
    return cloneProfile(this.profile);
  }

  async update(input: GroupProfileUpdateInput): Promise<GroupProfileRecord> {
    this.profile = {
      ...this.profile,
      ...compactProfileUpdate(input),
      preferences: input.preferences ? { ...input.preferences } : this.profile.preferences,
      updatedAt: new Date().toISOString(),
    };
    return this.get();
  }
}

export function compactProfileUpdate(input: GroupProfileUpdateInput): GroupProfileUpdateInput {
  return {
    name: input.name?.trim() || undefined,
    description: input.description?.trim() ?? undefined,
    preferences: input.preferences,
  };
}

function cloneProfile(profile: GroupProfileRecord): GroupProfileRecord {
  return {
    ...profile,
    preferences: { ...profile.preferences },
  };
}
