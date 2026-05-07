import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

const trimOptional = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export class EvaluateRetrievalScopeFilterDto {
  @IsIn(["global", "group", "user", "thread", "run"])
  scope!: "global" | "group" | "user" | "thread" | "run";

  @IsOptional()
  @IsString()
  @Transform(trimOptional)
  scopeId?: string;
}

export class EvaluateRetrievalCaseDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  expectedMemoryIds!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvaluateRetrievalScopeFilterDto)
  visibleScopes?: EvaluateRetrievalScopeFilterDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minRecall?: number;
}

export class EvaluateRetrievalDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EvaluateRetrievalCaseDto)
  cases!: EvaluateRetrievalCaseDto[];
}
