import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { UpdateGroupProfileDto } from "./dto/update-group-profile.dto.js";
import { GroupProfileService } from "./group-profile.service.js";

@Controller("api/group-profile")
export class GroupProfileController {
  constructor(@Inject(GroupProfileService) private readonly service: GroupProfileService) {}

  @Get()
  async get() {
    return { groupProfile: await this.service.get() };
  }

  @Patch()
  async update(@Body() body: UpdateGroupProfileDto) {
    return { groupProfile: await this.service.update(body) };
  }
}
