import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ChannelIdentityRecord,
  UserRecord,
  UserStore,
} from "../../../instance/userStore.js";
import type { RunStore } from "../../../runs/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { RUN_STORE, USER_STORE } from "../../persistence/tokens.js";
import type { CreateChannelIdentityDto } from "./dto/create-channel-identity.dto.js";
import type { CreateUserDto } from "./dto/create-user.dto.js";
import type { UpdateChannelIdentityDto } from "./dto/update-channel-identity.dto.js";
import type { UpdateUserDto } from "./dto/update-user.dto.js";

type UserListEntry = UserRecord & {
  status: "active";
  recentRequests: Array<{
    id: string;
    task: string;
    status: string;
    channel?: string;
    threadId?: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<UserListEntry[]> {
    const [runs, users] = await Promise.all([this.runs.list(), this.users.list()]);
    return users.map((user) => ({
      ...user,
      status: "active",
      recentRequests: runs
        .filter((run) => run.requesterUserId === user.id)
        .slice(0, 5)
        .map((run) => ({
          id: run.id,
          task: run.task,
          status: run.status,
          channel: run.channel,
          threadId: run.threadId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        })),
    }));
  }

  async create(dto: CreateUserDto): Promise<UserRecord> {
    let user: UserRecord;
    try {
      user = await this.users.create({
        id: dto.id,
        displayName: dto.displayName,
        role: dto.role,
        roles: dto.roles,
      });
    } catch (error) {
      throw new BadRequestException(this.errorMessage(error, "Invalid user create request"));
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "user.created",
      targetType: "user",
      targetId: user.id,
      status: "success",
      summary: `User created: ${user.displayName}`,
      metadata: { role: user.role, roles: user.roles },
    });
    return user;
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserRecord> {
    let user: UserRecord;
    try {
      user = await this.users.update(id, {
        displayName: dto.displayName,
        role: dto.role,
        roles: dto.roles,
      });
    } catch (error) {
      const message = this.errorMessage(error, "Invalid user update request");
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "user.updated",
      targetType: "user",
      targetId: user.id,
      status: "success",
      summary: `User updated: ${user.displayName}`,
      metadata: { role: user.role, roles: user.roles },
    });
    return user;
  }

  async delete(id: string): Promise<{ deleted: true; userId: string }> {
    let deleted: boolean;
    try {
      deleted = await this.users.delete(id);
    } catch (error) {
      throw new BadRequestException(this.errorMessage(error, "Could not delete user"));
    }
    if (!deleted) throw new NotFoundException("User not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "user.deleted",
      targetType: "user",
      targetId: id,
      status: "success",
      summary: `User deleted: ${id}`,
    });
    return { deleted: true, userId: id };
  }

  async createIdentity(userId: string, dto: CreateChannelIdentityDto): Promise<ChannelIdentityRecord> {
    let identity: ChannelIdentityRecord;
    try {
      identity = await this.users.createIdentity({
        id: dto.id,
        userId,
        provider: dto.provider,
        providerUserId: dto.providerUserId,
        allowStatus: dto.allowStatus,
        displayMetadata: dto.displayMetadata,
        lastSeenAt: dto.lastSeenAt,
      });
    } catch (error) {
      throw new BadRequestException(this.errorMessage(error, "Invalid channel identity create request"));
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "channel_identity.created",
      targetType: "channel_identity",
      targetId: identity.id,
      status: identity.allowStatus === "allowed" ? "success" : "pending",
      requesterUserId: identity.userId,
      channel: identity.provider,
      summary: `Channel identity created: ${identity.provider}/${identity.providerUserId}`,
      metadata: {
        userId: identity.userId,
        allowStatus: identity.allowStatus,
      },
    });
    return identity;
  }

  async updateIdentity(id: string, dto: UpdateChannelIdentityDto): Promise<ChannelIdentityRecord> {
    let identity: ChannelIdentityRecord;
    try {
      identity = await this.users.updateIdentity(id, {
        allowStatus: dto.allowStatus,
        displayMetadata: dto.displayMetadata,
        lastSeenAt: dto.lastSeenAt,
      });
    } catch (error) {
      const message = this.errorMessage(error, "Invalid channel identity update request");
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "channel_identity.updated",
      targetType: "channel_identity",
      targetId: identity.id,
      status: identity.allowStatus === "allowed" ? "success" : "pending",
      requesterUserId: identity.userId,
      channel: identity.provider,
      summary: `Channel identity updated: ${identity.provider}/${identity.providerUserId}`,
      metadata: {
        userId: identity.userId,
        allowStatus: identity.allowStatus,
      },
    });
    return identity;
  }

  async deleteIdentity(id: string): Promise<{ deleted: true; identityId: string }> {
    const deleted = await this.users.deleteIdentity(id);
    if (!deleted) throw new NotFoundException("Channel identity not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "channel_identity.deleted",
      targetType: "channel_identity",
      targetId: id,
      status: "success",
      summary: `Channel identity deleted: ${id}`,
    });
    return { deleted: true, identityId: id };
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
