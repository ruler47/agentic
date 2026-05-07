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

@Injectable()
export class SecretsService {
  constructor(
    @Inject(SECRET_HANDLE_STORE) private readonly store: SecretHandleStore | undefined,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SecretHandleRecord[]> {
    return this.store ? this.store.list() : [];
  }

  async create(rawBody: unknown, dto: CreateSecretHandleDto): Promise<SecretHandleRecord> {
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
          secretRef: record.secretRef,
          scopes: record.scopes,
        },
      });
      return record;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid secret handle request",
      );
    }
  }

  async get(handle: string): Promise<SecretHandleRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Secret handle store is not configured");
    }
    const record = await this.store.get(handle);
    if (!record) throw new NotFoundException("Secret handle not found");
    return record;
  }

  async delete(handle: string): Promise<{ deleted: true; secretHandle: SecretHandleRecord }> {
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
        secretRef: existing.secretRef,
        scopes: existing.scopes,
      },
    });
    return { deleted: true, secretHandle: existing };
  }
}
