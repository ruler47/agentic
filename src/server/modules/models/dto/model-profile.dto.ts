import { Transform } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
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

export class UpsertModelProfileDto {
  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  providerId?: string;

  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  modelId!: string;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(["chat", "embedding", "vision", "reasoning", "coding", "tool-calling"], { each: true })
  @Transform(splitToArray)
  capabilities?: Array<"chat" | "embedding" | "vision" | "reasoning" | "coding" | "tool-calling">;

  @IsOptional()
  @IsBoolean()
  capabilitiesOverridden?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(["classification", "planning", "coding", "vision", "synthesis", "tool-use"], { each: true })
  @Transform(splitToArray)
  preferredRoles?: Array<"classification" | "planning" | "coding" | "vision" | "synthesis" | "tool-use">;

  @IsOptional()
  @IsInt()
  @Min(1)
  contextWindow?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  operatorNotes?: string;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  verifiedAt?: string;
}
