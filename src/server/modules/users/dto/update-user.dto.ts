import { Transform } from "class-transformer";
import { IsArray, IsOptional, IsString } from "class-validator";

const trimToOptional = ({ value }: { value: unknown }): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  role?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}
