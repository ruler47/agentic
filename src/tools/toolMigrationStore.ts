import { randomUUID } from "node:crypto";

export type ToolMigrationStatus = "pending" | "applied" | "failed" | "rolled_back";

export type ToolMigrationRecord = {
  id: string;
  toolName: string;
  toolVersion: string;
  migrationId: string;
  checksum: string;
  status: ToolMigrationStatus;
  appliedAt?: string;
  appliedByActor?: string;
  qaReport?: Record<string, unknown>;
  rollbackNotes?: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolMigrationCreateInput = {
  toolName: string;
  toolVersion: string;
  migrationId: string;
  checksum: string;
  status?: ToolMigrationStatus;
  appliedAt?: Date;
  appliedByActor?: string;
  qaReport?: Record<string, unknown>;
  rollbackNotes?: string;
};

export type ToolMigrationUpdateInput = {
  status?: ToolMigrationStatus;
  appliedAt?: Date;
  appliedByActor?: string;
  qaReport?: Record<string, unknown>;
  rollbackNotes?: string;
};

export type ToolMigrationListOptions = {
  toolName?: string;
  status?: ToolMigrationStatus;
};

export type ToolMigrationStore = {
  list(options?: ToolMigrationListOptions): Promise<ToolMigrationRecord[]>;
  create(input: ToolMigrationCreateInput): Promise<ToolMigrationRecord>;
  update(id: string, input: ToolMigrationUpdateInput): Promise<ToolMigrationRecord>;
};

export class InMemoryToolMigrationStore implements ToolMigrationStore {
  private readonly migrations = new Map<string, ToolMigrationRecord>();

  async list(options: ToolMigrationListOptions = {}): Promise<ToolMigrationRecord[]> {
    return [...this.migrations.values()]
      .filter((migration) => !options.toolName || migration.toolName === options.toolName)
      .filter((migration) => !options.status || migration.status === options.status)
      .map(cloneMigration)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: ToolMigrationCreateInput): Promise<ToolMigrationRecord> {
    validateCreateInput(input);
    const now = new Date().toISOString();
    const record: ToolMigrationRecord = {
      id: `tool_migration_${randomUUID()}`,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      migrationId: input.migrationId,
      checksum: input.checksum,
      status: input.status ?? "pending",
      appliedAt: input.appliedAt?.toISOString(),
      appliedByActor: input.appliedByActor,
      qaReport: input.qaReport ? cloneJson(input.qaReport) : undefined,
      rollbackNotes: input.rollbackNotes,
      createdAt: now,
      updatedAt: now,
    };
    this.migrations.set(record.id, cloneMigration(record));
    return cloneMigration(record);
  }

  async update(id: string, input: ToolMigrationUpdateInput): Promise<ToolMigrationRecord> {
    const existing = this.migrations.get(id);
    if (!existing) {
      throw new Error(`Tool migration ${id} was not found.`);
    }
    const updated: ToolMigrationRecord = {
      ...existing,
      status: input.status ?? existing.status,
      appliedAt: input.appliedAt?.toISOString() ?? existing.appliedAt,
      appliedByActor: input.appliedByActor ?? existing.appliedByActor,
      qaReport: input.qaReport ? cloneJson(input.qaReport) : existing.qaReport,
      rollbackNotes: input.rollbackNotes ?? existing.rollbackNotes,
      updatedAt: new Date().toISOString(),
    };
    this.migrations.set(id, cloneMigration(updated));
    return cloneMigration(updated);
  }
}

export function validateToolMigrationStatus(status: string): ToolMigrationStatus {
  if (status === "pending" || status === "applied" || status === "failed" || status === "rolled_back") {
    return status;
  }
  throw new Error(`Unsupported tool migration status: ${status}`);
}

function validateCreateInput(input: ToolMigrationCreateInput): void {
  for (const [field, value] of Object.entries({
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    migrationId: input.migrationId,
    checksum: input.checksum,
  })) {
    if (!value || !String(value).trim()) {
      throw new Error(`Tool migration ${field} is required.`);
    }
  }
}

function cloneMigration(record: ToolMigrationRecord): ToolMigrationRecord {
  return {
    ...record,
    qaReport: record.qaReport ? cloneJson(record.qaReport) : undefined,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
