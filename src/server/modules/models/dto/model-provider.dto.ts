import { Transform } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from "class-validator";

const trimRequired = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimOptional = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const splitToArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
};

export class CreateModelProviderDto {
  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  id?: string;

  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  label!: string;

  @IsIn(["chat", "embedding"])
  kind!: "chat" | "embedding";

  @IsIn(["local", "remote", "openai-compatible", "deterministic"])
  providerType!: "local" | "remote" | "openai-compatible" | "deterministic";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  baseUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(splitToArray)
  modelIds?: string[];

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  defaultModel?: string;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  apiKeySecretHandle?: string;

  @IsOptional()
  @IsNumber()
  dimensions?: number;

  @IsOptional()
  @IsIn(["available", "disabled", "failed"])
  status?: "available" | "disabled" | "failed";

  @IsOptional()
  @IsIn(["unknown", "ok", "failed"])
  healthStatus?: "unknown" | "ok" | "failed";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  healthDetail?: string;
}

export class UpdateModelProviderDto {
  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  label?: string;

  @IsOptional()
  @IsIn(["chat", "embedding"])
  kind?: "chat" | "embedding";

  @IsOptional()
  @IsIn(["local", "remote", "openai-compatible", "deterministic"])
  providerType?: "local" | "remote" | "openai-compatible" | "deterministic";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  baseUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(splitToArray)
  modelIds?: string[];

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  defaultModel?: string;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  apiKeySecretHandle?: string;

  @IsOptional()
  @IsNumber()
  dimensions?: number;

  @IsOptional()
  @IsIn(["available", "disabled", "failed"])
  status?: "available" | "disabled" | "failed";

  @IsOptional()
  @IsIn(["unknown", "ok", "failed"])
  healthStatus?: "unknown" | "ok" | "failed";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  healthDetail?: string;
}
