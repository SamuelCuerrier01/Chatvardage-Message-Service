import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';

export class PresenceDto {
  @IsIn(['en-ligne', 'hors-ligne']) statut!: 'en-ligne' | 'hors-ligne';
}

export const MAX_PRESENCES_SUIVIES = 500;

export class SuivrePresenceDto {
  @IsArray()
  @ArrayMaxSize(MAX_PRESENCES_SUIVIES)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  ids!: string[];
}
