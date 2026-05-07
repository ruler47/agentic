import { IsObject, IsOptional, IsString } from "class-validator";

export class UpdateGroupProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;
}
