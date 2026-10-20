import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RedisService } from '../redis.service';
import { EvenementServeurDto } from './evenement-serveur.dto';
import {
  EN_TETE_JETON_INTERNE,
  InternalTokenGuard,
} from './internal-token.guard';

export const SERVEUR_CHANNEL = 'serveur.change';
export const SESSIONS_CHANNEL = 'sessions.revoquees';

@ApiTags('Interne')
@ApiHeader({ name: EN_TETE_JETON_INTERNE, required: true })
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalEventsController {
  constructor(private readonly redis: RedisService) {}

  @Post('events')
  @ApiOperation({
    summary: 'Diffuse un changement de serveur (appelée par Room-Service)',
  })
  @HttpCode(202)
  async recevoir(@Body() dto: EvenementServeurDto): Promise<{ accepte: true }> {
    await this.redis.publish(SERVEUR_CHANNEL, {
      serveurId: dto.serveurId,
      raison: dto.raison,
      cibleId: dto.cibleId ?? null,
      tous: dto.tous === true,
      utilisateurIds: dto.tous ? [] : [...new Set(dto.utilisateurIds)],
    });
    return { accepte: true };
  }

  @Post('users/:userId/sessions-revoquees')
  @ApiOperation({
    summary:
      "Sessions d'un compte invalidées (appelée par Authentification) : ses sockets au jeton révoqué sont fermés aussitôt",
  })
  @HttpCode(202)
  async sessionsRevoquees(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<{ accepte: true }> {
    await this.redis.publish(SESSIONS_CHANNEL, { userId });
    return { accepte: true };
  }
}
