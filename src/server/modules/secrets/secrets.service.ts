import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  rejectRawSecretPayload,
  type SecretHandleRecord,
  type SecretHandleStore,
} from "../../../secrets/secretHandleStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import { SECRET_HANDLE_STORE } from "../../persistence/tokens.js";
import type { CreateSecretHandleDto } from "./dto/create-secret-handle.dto.js";

export type PublicSecretHandleRecord = SecretHandleRecord;

export type SecretHandleStatus = {
  handle: string;
  registered: boolean;
  resolvable: boolean;
  provider?: SecretHandleRecord["provider"];
  secretRef?: string;
  scopes?: string[];
  reason?: "not_registered" | "unresolved" | "resolved";
};

@Injectable()
export class SecretsService {
  constructor(
    @Inject(SECRET_HANDLE_STORE) private readonly store: SecretHandleStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<PublicSecretHandleRecord[]> {
    return this.store ? (await this.store.list()).map(toPublicSecretHandle) : [];
  }

  async create(rawBody: unknown, dto: CreateSecretHandleDto): Promise<PublicSecretHandleRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Secret handle store is not configured");
    }
    try {
      rejectRawSecretPayload(rawBody);
      const record = await this.store.create({
        handle: dto.handle,
        label: dto.label,
        provider: dto.provider,
        secretRef: dto.secretRef,
        scopes: dto.scopes,
      });
      await this.audit.record({
        instanceId: "instance-local",
        actorId: "user-admin",
        actorType: "user",
        action: "secret_handle.created",
        targetType: "secret_handle",
        targetId: record.handle,
        status: "success",
        summary: `Secret handle created: ${record.handle}`,
        metadata: {
          provider: record.provider,
          secretRef: publicSecretRef(record),
          scopes: record.scopes,
        },
      });
      return toPublicSecretHandle(record);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid secret handle request",
      );
    }
  }

  async get(handle: string): Promise<PublicSecretHandleRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Secret handle store is not configured");
    }
    const record = await this.store.get(handle);
    if (!record) throw new NotFoundException("Secret handle not found");
    return toPublicSecretHandle(record);
  }

  async status(handles: string[]): Promise<{ handles: SecretHandleStatus[] }> {
    if (!this.store) {
      throw new ServiceUnavailableException("Secret handle store is not configured");
    }
    const uniqueHandles = [...new Set(handles.map((handle) => handle.trim()).filter(Boolean))].slice(0, 50);
    const statuses = await Promise.all(uniqueHandles.map(async (handle): Promise<SecretHandleStatus> => {
      const record = await this.store!.get(handle);
      if (!record) {
        return {
          handle,
          registered: false,
          resolvable: false,
          reason: "not_registered",
        };
      }
      const resolved = this.store!.resolve ? await this.store!.resolve(handle) : undefined;
      return {
        handle,
        registered: true,
        resolvable: resolved !== undefined,
        provider: record.provider,
        secretRef: publicSecretRef(record),
        scopes: [...record.scopes],
        reason: resolved !== undefined ? "resolved" : "unresolved",
      };
    }));
    return { handles: statuses };
  }

  async delete(handle: string): Promise<{ deleted: true; secretHandle: PublicSecretHandleRecord }> {
    if (!this.store) {
      throw new ServiceUnavailableException("Secret handle store is not configured");
    }
    const existing = await this.store.get(handle);
    if (!existing) throw new NotFoundException("Secret handle not found");
    await this.store.delete(handle);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "secret_handle.deleted",
      targetType: "secret_handle",
      targetId: handle,
      status: "success",
      summary: `Secret handle deleted: ${handle}`,
      metadata: {
        provider: existing.provider,
        secretRef: publicSecretRef(existing),
        scopes: existing.scopes,
      },
    });
    return { deleted: true, secretHandle: toPublicSecretHandle(existing) };
  }
}

function toPublicSecretHandle(record: SecretHandleRecord): PublicSecretHandleRecord {
  return {
    ...record,
    secretRef: publicSecretRef(record),
  };
}

function publicSecretRef(record: Pick<SecretHandleRecord, "provider" | "secretRef">): string {
  return record.provider === "inline" ? "[redacted inline secret]" : record.secretRef;
}
