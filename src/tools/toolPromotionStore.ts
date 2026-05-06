import { randomUUID } from "node:crypto";

export type ToolPromotionStatus = "promoted";

export type ToolPromotionRecord = {
  id: string;
  toolName: string;
  toolVersion: string;
  status: ToolPromotionStatus;
  promotedAt: string;
  buildRequestId?: string;
  qaReport?: Record<string, unknown>;
  packageRef?: string;
  migrationIds: string[];
  summary: string;
  createdAt: string;
};

export type ToolPromotionCreateInput = {
  toolName: string;
  toolVersion: string;
  status?: ToolPromotionStatus;
  promotedAt?: Date;
  buildRequestId?: string;
  qaReport?: Record<string, unknown>;
  packageRef?: string;
  migrationIds?: string[];
  summary: string;
};

export type ToolPromotionListOptions = {
  toolName?: string;
  buildRequestId?: string;
};

export type ToolPromotionStore = {
  list(options?: ToolPromotionListOptions): Promise<ToolPromotionRecord[]>;
  create(input: ToolPromotionCreateInput): Promise<ToolPromotionRecord>;
};

export class InMemoryToolPromotionStore implements ToolPromotionStore {
  private readonly promotions = new Map<string, ToolPromotionRecord>();

  async list(options: ToolPromotionListOptions = {}): Promise<ToolPromotionRecord[]> {
    return [...this.promotions.values()]
      .filter((promotion) => !options.toolName || promotion.toolName === options.toolName)
      .filter((promotion) => !options.buildRequestId || promotion.buildRequestId === options.buildRequestId)
      .map(clonePromotion)
      .sort((a, b) => b.promotedAt.localeCompare(a.promotedAt));
  }

  async create(input: ToolPromotionCreateInput): Promise<ToolPromotionRecord> {
    validateToolPromotionCreateInput(input);
    const promotedAt = input.promotedAt?.toISOString() ?? new Date().toISOString();
    const record: ToolPromotionRecord = {
      id: `tool_promotion_${randomUUID()}`,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      status: input.status ?? "promoted",
      promotedAt,
      buildRequestId: input.buildRequestId,
      qaReport: input.qaReport ? cloneJson(input.qaReport) : undefined,
      packageRef: input.packageRef,
      migrationIds: [...(input.migrationIds ?? [])],
      summary: input.summary,
      createdAt: promotedAt,
    };
    this.promotions.set(record.id, clonePromotion(record));
    return clonePromotion(record);
  }
}

export function validateToolPromotionCreateInput(input: ToolPromotionCreateInput): void {
  for (const [field, value] of Object.entries({
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    summary: input.summary,
  })) {
    if (!value || !String(value).trim()) {
      throw new Error(`Tool promotion ${field} is required.`);
    }
  }
  if (input.status && input.status !== "promoted") {
    throw new Error(`Unsupported tool promotion status: ${input.status}`);
  }
}

function clonePromotion(record: ToolPromotionRecord): ToolPromotionRecord {
  return {
    ...record,
    qaReport: record.qaReport ? cloneJson(record.qaReport) : undefined,
    migrationIds: [...record.migrationIds],
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
