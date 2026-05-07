import { Transform } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

const trimRequired = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimOptional = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class UpdateMemoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  summary?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(trimRequired)
  reusableProcedure?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(["global", "group", "user", "thread", "run"])
  scope?: "global" | "group" | "user" | "thread" | "run";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  scopeId?: string;

  @IsOptional()
  @IsIn(["proposed", "accepted", "rejected", "archived"])
  status?: "proposed" | "accepted" | "rejected" | "archived";

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsIn(["normal", "sensitive", "private"])
  sensitivity?: "normal" | "sensitive" | "private";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  sourceRunId?: string;

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  sourceThreadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidence?: string[];
}
