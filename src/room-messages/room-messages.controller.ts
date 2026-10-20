import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoomMessage } from '@prisma/client';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MarquerLuDto } from '../lecture/dto/marquer-lu.dto';
import {
  EtatLecture,
  EtatLectureService,
  Lecteur,
} from '../lecture/etat-lecture.service';
import { extraireJetonBearer } from '../partage/client-auth';
import { CreateAdminRoomMessageDto } from './dto/create-admin-room-message.dto';
import { CreateRoomMessageDto } from './dto/create-room-message.dto';
import { RoomHistoryQueryDto } from './dto/room-history-query.dto';
import { UpdateRoomMessageDto } from './dto/update-room-message.dto';
import { RoomMessagesService } from './room-messages.service';

@ApiTags('Messages de salon')
@ApiBearerAuth()
@Controller('messages/rooms')
@UseGuards(JwtAuthGuard)
export class RoomMessagesController {
  constructor(
    private readonly roomMessages: RoomMessagesService,
    private readonly lecture: EtatLectureService,
  ) {}

  @Post(':roomId')
  @ApiOperation({
    summary: 'Envoie un message dans un salon',
    description: "Droit d'écriture vérifié auprès de Room-Service.",
  })
  create(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Body() dto: CreateRoomMessageDto,
  ): Promise<RoomMessage> {
    return this.roomMessages.create(req.auth, roomId, dto);
  }

  @Post(':roomId/admin')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: "Crée un message de salon au nom d'un membre",
    description: 'Admin requis.',
  })
  @ApiForbiddenResponse({ description: 'Rôle admin requis' })
  createForAdmin(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Body() dto: CreateAdminRoomMessageDto,
  ): Promise<RoomMessage> {
    return this.roomMessages.createForAdmin(
      req.auth,
      roomId,
      dto,
      extraireJetonBearer(req.headers.authorization),
    );
  }

  @Put(':roomId/read')
  @ApiOperation({
    summary: 'Marque un salon comme lu',
    description:
      "Lecture du salon requise. Jusqu'à `messageId`, ou jusqu'au dernier message ; l'état ne recule jamais.",
  })
  markRead(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Body() dto: MarquerLuDto,
  ): Promise<EtatLecture> {
    return this.lecture.marquerSalonLu(req.auth, roomId, dto.messageId);
  }

  @Get(':roomId/read-states')
  @ApiOperation({
    summary: 'Lecteurs du salon (« Vu par »)',
    description:
      "Lecture du salon requise. Autres membres et date du dernier message qu'ils ont lu, du plus récent au plus ancien (100 au plus).",
  })
  async readStates(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
  ): Promise<{ lecteurs: Lecteur[] }> {
    return { lecteurs: await this.lecture.lecteursSalon(req.auth, roomId) };
  }

  @Get(':roomId/history')
  @ApiOperation({
    summary: "Historique d'un salon",
    description: 'Membres du salon ; paginé par `cursor`.',
  })
  history(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Query() query: RoomHistoryQueryDto,
  ): Promise<RoomMessage[]> {
    return this.roomMessages.history(req.auth, roomId, query);
  }

  @Get(':roomId/:id')
  @ApiOperation({ summary: 'Lit un message de salon' })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Param('id') id: string,
  ): Promise<RoomMessage> {
    return this.roomMessages.findOne(req.auth, roomId, id);
  }

  @Patch(':roomId/:id')
  @ApiOperation({
    summary: 'Modifie un message de salon',
    description: 'Auteur seulement.',
  })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRoomMessageDto,
  ): Promise<RoomMessage> {
    return this.roomMessages.update(req.auth, roomId, id, dto);
  }

  @Delete(':roomId/:id')
  @ApiOperation({
    summary: 'Supprime un message de salon',
    description: 'Auteur, modérateur du serveur, propriétaire ou admin.',
  })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('roomId') roomId: string,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    await this.roomMessages.remove(req.auth, roomId, id);
    return { deleted: true };
  }
}
