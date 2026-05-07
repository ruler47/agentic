import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

export class TierSettingDto {
  @IsIn(["S", "M", "L", "XL"])
  tier!: "S" | "M" | "L" | "XL";

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  models!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  maxAttempts?: number;

  @IsOptional()
  @IsBoolean()
  escalateOnFailure?: boolean;
}

export class UpdateTiersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierSettingDto)
  tiers!: TierSettingDto[];
}
