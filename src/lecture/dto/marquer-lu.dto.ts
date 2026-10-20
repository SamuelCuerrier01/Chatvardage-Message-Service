import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class MarquerLuDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Dernier message lu (doit appartenir à la conversation). Absent : le message le plus récent.',
  })
  @IsOptional()
  @IsUUID()
  messageId?: string;
}
