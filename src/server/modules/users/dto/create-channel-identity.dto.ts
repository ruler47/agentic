import { Transform } from "class-transformer";
import { IsIn, IsObject, IsOptional, IsString } from "class-validator";

const trimToOptional = ({ value }: { value: unknown }): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class CreateChannelIdentityDto {
  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  id?: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  provider!: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  providerUserId!: string;

  @IsOptional()
  @IsIn(["allowed", "blocked"])
  allowStatus?: "allowed" | "blocked";

  @IsOptional()
  @IsObject()
  displayMetadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  lastSeenAt?: string;
}
