import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { DestinatairesService } from '../destinataires.service';
import { EtatLectureService } from '../lecture/etat-lecture.service';
import { MessagesService } from '../messages/messages.service';
import { RoomMessagesService } from '../room-messages/room-messages.service';
import {
  EN_TETE_JETON_INTERNE,
  InternalTokenGuard,
} from './internal-token.guard';

export class SalonsSupprimesDto {
  @ApiProperty({ type: [String], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  salonIds!: string[];
}

@ApiTags('Interne')
@ApiHeader({ name: EN_TETE_JETON_INTERNE, required: true })
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalDonneesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly roomMessages: RoomMessagesService,
    private readonly destinataires: DestinatairesService,
    private readonly lecture: EtatLectureService,
  ) {}

  @Post('salons-supprimes')
  @ApiOperation({
    summary:
      'Efface les messages de salons supprimés (appelée par Room-Service)',
  })
  @HttpCode(200)
  async salonsSupprimes(
    @Body() dto: SalonsSupprimesDto,
  ): Promise<{ messagesSalons: number }> {
    const [messagesSalons] = await Promise.all([
      this.roomMessages.purgerSalons(dto.salonIds),
      this.lecture.purgerSalons(dto.salonIds),
    ]);
    return { messagesSalons };
  }

  @Delete('users/:userId')
  @ApiOperation({
    summary:
      "Efface les messages d'un compte supprimé (appelée par Authentification)",
  })
  async supprimerUtilisateur(
    @Param('userId') userId: string,
  ): Promise<{ messagesPrives: number; messagesSalons: number }> {
    this.destinataires.oublier(userId);
    const [messagesPrives, messagesSalons] = await Promise.all([
      this.messages.supprimerUtilisateur(userId),
      this.roomMessages.supprimerAuteur(userId),
      this.lecture.supprimerUtilisateur(userId),
    ]);
    return { messagesPrives, messagesSalons };
  }
}
