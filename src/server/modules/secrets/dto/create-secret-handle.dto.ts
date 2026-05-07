import { Transform } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator";

const trimRequired = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimOptional = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class CreateSecretHandleDto {
  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  handle?: string;

  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  label!: string;

  @IsIn(["env", "external", "inline"])
  provider!: "env" | "external" | "inline";

  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  secretRef!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}
