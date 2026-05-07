import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { CreateChannelIdentityDto } from "./dto/create-channel-identity.dto.js";
import { CreateUserDto } from "./dto/create-user.dto.js";
import { UpdateChannelIdentityDto } from "./dto/update-channel-identity.dto.js";
import { UpdateUserDto } from "./dto/update-user.dto.js";
import { UsersService } from "./users.service.js";

@Controller("api")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("users")
  async list() {
    return { users: await this.users.list() };
  }

  @Post("users")
  @HttpCode(201)
  async create(@Body() dto: CreateUserDto) {
    return { user: await this.users.create(dto) };
  }

  @Patch("users/:id")
  async update(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    return { user: await this.users.update(decodeURIComponent(id), dto) };
  }

  @Delete("users/:id")
  async delete(@Param("id") id: string) {
    return this.users.delete(decodeURIComponent(id));
  }

  @Post("users/:id/channel-identities")
  @HttpCode(201)
  async createIdentity(
    @Param("id") userId: string,
    @Body() dto: CreateChannelIdentityDto,
  ) {
    return { identity: await this.users.createIdentity(decodeURIComponent(userId), dto) };
  }

  @Patch("channel-identities/:id")
  async updateIdentity(
    @Param("id") id: string,
    @Body() dto: UpdateChannelIdentityDto,
  ) {
    return { identity: await this.users.updateIdentity(decodeURIComponent(id), dto) };
  }

  @Delete("channel-identities/:id")
  async deleteIdentity(@Param("id") id: string) {
    return this.users.deleteIdentity(decodeURIComponent(id));
  }
}
