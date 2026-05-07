import { IsIn, IsObject, IsOptional, IsString, ValidateIf } from "class-validator";

export class UpdateChannelIdentityDto {
  @IsOptional()
  @IsIn(["allowed", "blocked"])
  allowStatus?: "allowed" | "blocked";

  @IsOptional()
  @IsObject()
  displayMetadata?: Record<string, unknown>;

  @ValidateIf((_object, value) => value !== null)
  @IsOptional()
  @IsString()
  lastSeenAt?: string | null;
}
