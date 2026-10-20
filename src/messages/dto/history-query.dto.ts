import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class HistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Identifiant du dernier message reçu (page suivante).',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description:
      'Message de depart inclus, sans charger les pages intermediaires.',
  })
  @IsOptional()
  @IsString()
  around?: string;

  @ApiPropertyOptional({ enum: ['before', 'after'], default: 'before' })
  @IsOptional()
  @IsIn(['before', 'after'])
  direction?: 'before' | 'after';

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class AdminHistoryQueryDto extends HistoryQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filtre les messages envoyés ou reçus par cet utilisateur.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
