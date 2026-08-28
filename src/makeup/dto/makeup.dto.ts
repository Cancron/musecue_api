import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RegisterMockImageDto {
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mimeType!: string;

  @IsInt()
  @Min(320)
  @Max(8192)
  width!: number;

  @IsInt()
  @Min(320)
  @Max(8192)
  height!: number;

  @IsInt()
  @Min(1)
  @Max(20_000_000)
  sizeBytes!: number;
}

export class SavePreferencesDto {
  @IsString()
  @IsIn(['natural', 'soft', 'glam', 'bold'])
  vibe!: string;

  @IsInt()
  @Min(5)
  @Max(120)
  timeMinutes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  skillLevel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  occasion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  desiredEffect?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AskQuestionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question!: string;
}

export class CompleteStepDto {
  @IsOptional()
  @IsIn(['COMPLETED', 'SKIPPED'])
  outcome?: 'COMPLETED' | 'SKIPPED';
}

export class ListSessionsDto {
  @IsOptional()
  @IsIn(['active', 'completed', 'all'])
  scope?: 'active' | 'completed' | 'all';
}
