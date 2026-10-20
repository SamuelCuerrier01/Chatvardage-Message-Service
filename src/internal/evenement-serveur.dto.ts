import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const RAISONS_SERVEUR = [
  'modifie',
  'supprime',
  'membres',
  'expulse',
  'invitation',
  'salons',
] as const;

export type RaisonServeur = (typeof RAISONS_SERVEUR)[number];

export class EvenementServeurDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  serveurId!: string;

  @ApiProperty({ enum: RAISONS_SERVEUR })
  @IsIn(RAISONS_SERVEUR)
  raison!: RaisonServeur;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  cibleId?: string;

  @ApiPropertyOptional({
    description: 'Diffuser à tous les clients connectés (serveur par défaut).',
  })
  @IsOptional()
  @IsBoolean()
  tous?: boolean;

  @ApiPropertyOptional({ type: [String], maxItems: 10_000 })
  @ValidateIf((dto: EvenementServeurDto) => dto.tous !== true)
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  utilisateurIds?: string[];
}
