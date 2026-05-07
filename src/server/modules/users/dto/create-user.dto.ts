import { Transform } from "class-transformer";
import { IsArray, IsNotEmpty, IsOptional, IsString } from "class-validator";

const trimToOptional = ({ value }: { value: unknown }): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class CreateUserDto {
  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  id?: string;

  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value : value))
  displayName!: string;

  @IsOptional()
  @IsString()
  @Transform(trimToOptional)
  role?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}
