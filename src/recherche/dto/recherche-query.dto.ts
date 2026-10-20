import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RechercheQueryDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 100,
    description:
      'Texte cherché dans le contenu, sans tenir compte de la casse (`%` et `_` pris littéralement).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 100)
  q!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({
    description: '`nextCursor` de la page précédente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({
    example: 'room:00000000-0000-4000-8000-000000000003',
    description:
      'Limite la recherche à une conversation : `dm:<interlocuteur>` ou `room:<salon>`. Absent : toutes les conversations accessibles.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^(dm|room):[^:]+$/, {
    message: 'conversationId doit être de la forme dm:<id> ou room:<id>',
  })
  conversationId?: string;
}
