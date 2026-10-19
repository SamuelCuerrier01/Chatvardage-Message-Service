import { PickType } from '@nestjs/swagger';
import { RechercheQueryDto } from './recherche-query.dto';

export class ResumeRechercheQueryDto extends PickType(RechercheQueryDto, [
  'q',
] as const) {}
