import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { GroupProfileRecord, GroupProfileStore } from "../../../instance/groupProfileStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import { GROUP_PROFILE_STORE } from "../../persistence/tokens.js";
import type { UpdateGroupProfileDto } from "./dto/update-group-profile.dto.js";

@Injectable()
export class GroupProfileService {
  constructor(
    @Inject(GROUP_PROFILE_STORE) private readonly store: GroupProfileStore | undefined,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<GroupProfileRecord> {
    if (this.store) return this.store.get();
    return {
      id: "group-local",
      instanceId: "instance-local",
      name: "Local Group Profile",
      description: "Default one-group profile for local development.",
      preferences: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }

  async update(input: UpdateGroupProfileDto): Promise<GroupProfileRecord> {
    if (!this.store) {
      throw new ServiceUnavailableException("Group profile store is not configured");
    }
    const profile = await this.store.update({
      name: input.name?.trim() || undefined,
      description: input.description !== undefined ? input.description.trim() : undefined,
      preferences: input.preferences,
    });
    await this.audit.record({
      instanceId: profile.instanceId,
      actorId: "user-admin",
      actorType: "user",
      action: "group_profile.updated",
      targetType: "group_profile",
      targetId: profile.id,
      status: "success",
      summary: `Group profile updated: ${profile.name}`,
    });
    return profile;
  }
}
