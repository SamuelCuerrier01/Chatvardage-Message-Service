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
import { PrivateMessage } from '@prisma/client';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MarquerLuDto } from '../lecture/dto/marquer-lu.dto';
import {
  EtatLecture,
  EtatLectureService,
  Lecteur,
} from '../lecture/etat-lecture.service';
import { extraireJetonBearer } from '../partage/client-auth';
import { RechercheQueryDto } from '../recherche/dto/recherche-query.dto';
import { ResumeRechercheQueryDto } from '../recherche/dto/resume-recherche-query.dto';
import {
  PageRecherche,
  ResumeRecherche,
  RechercheService,
} from '../recherche/recherche.service';
import { ConversationSummary } from './dto/conversation-summary.dto';
import { CreateAdminMessageDto } from './dto/create-admin-message.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { AdminHistoryQueryDto, HistoryQueryDto } from './dto/history-query.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { MessagesService } from './messages.service';

@ApiTags('Messages privés')
@ApiBearerAuth()
@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly lecture: EtatLectureService,
    private readonly recherche: RechercheService,
  ) {}

  @Put(':id/delivered')
  @ApiOperation({
    summary: 'Confirme la reception du DM dans une application du destinataire',
  })
  markDelivered(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<PrivateMessage> {
    return this.messages.markDelivered(req.auth.id, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Envoie un DM',
    description:
      'Écrit le message en base, puis publie `private-message.created` sur Redis.',
  })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateMessageDto,
  ): Promise<PrivateMessage> {
    return this.messages.create(
      req.auth.id,
      dto,
      extraireJetonBearer(req.headers.authorization),
    );
  }

  @Post('admin')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: "Crée un DM au nom d'un utilisateur",
    description: 'Admin requis.',
  })
  @ApiForbiddenResponse({ description: 'Rôle admin requis' })
  createForAdmin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateAdminMessageDto,
  ): Promise<PrivateMessage> {
    return this.messages.createForAdmin(
      dto,
      extraireJetonBearer(req.headers.authorization),
      req.auth.id,
    );
  }

  @Get('history/:otherUserId')
  @ApiOperation({
    summary: 'Historique de la conversation avec un utilisateur',
    description: 'Du plus récent au plus ancien, paginé par `cursor`.',
  })
  history(
    @Req() req: AuthenticatedRequest,
    @Param('otherUserId') otherUserId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<PrivateMessage[]> {
    return this.messages.history(req.auth.id, otherUserId, query);
  }

  @Get('admin')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Liste tous les DM',
    description: 'Admin requis ; `userId` filtre par participant.',
  })
  @ApiForbiddenResponse({ description: 'Rôle admin requis' })
  findAllForAdmin(
    @Query() query: AdminHistoryQueryDto,
  ): Promise<PrivateMessage[]> {
    return this.messages.findAllForAdmin(query);
  }

  @Delete('admin/:id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Supprime un DM', description: 'Admin requis.' })
  @ApiForbiddenResponse({ description: 'Rôle admin requis' })
  async removeForAdmin(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    await this.messages.removeForAdmin(id, req.auth.id);
    return { deleted: true };
  }

  @Get('conversations')
  @ApiOperation({
    summary: 'Mes conversations privées',
    description: 'Dernier message de chaque interlocuteur.',
  })
  listConversations(
    @Req() req: AuthenticatedRequest,
  ): Promise<ConversationSummary[]> {
    return this.messages.listConversations(req.auth.id);
  }

  @Put('conversations/:otherUserId/read')
  @ApiOperation({
    summary: 'Marque une conversation privée comme lue',
    description:
      "Jusqu'à `messageId`, ou jusqu'au dernier message. L'état ne recule jamais.",
  })
  markDmRead(
    @Req() req: AuthenticatedRequest,
    @Param('otherUserId') otherUserId: string,
    @Body() dto: MarquerLuDto,
  ): Promise<EtatLecture> {
    return this.lecture.marquerDmLu(req.auth.id, otherUserId, dto.messageId);
  }

  @Get('conversations/:otherUserId/read-state')
  @ApiOperation({
    summary: "Accusé de lecture d'une conversation privée",
    description:
      "Jusqu'où l'interlocuteur a lu la conversation (`lastReadAt`, `null` s'il ne l'a jamais lue).",
  })
  dmReadState(
    @Req() req: AuthenticatedRequest,
    @Param('otherUserId') otherUserId: string,
  ): Promise<Lecteur> {
    return this.lecture.lecteurDm(req.auth.id, otherUserId);
  }

  @Get('unread')
  @ApiOperation({
    summary: 'Mes messages non lus',
    description:
      '`{ counts: { "dm:<id>": n, "room:<id>": n } }`, DM et salons lisibles ; seules les conversations avec des non-lus sont présentes.',
  })
  async unread(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ counts: Record<string, number> }> {
    return { counts: await this.lecture.compteurs(req.auth) };
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Dernière activité de mes salons',
    description:
      '`{ rooms: { "room:<id>": "<date du dernier message>" } }`, salons lisibles seulement ; les salons sans message sont absents. Sert à trier les serveurs par activité.',
  })
  async activity(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ rooms: Record<string, string> }> {
    return { rooms: await this.lecture.activiteSalons(req.auth) };
  }

  @Get('search/summary')
  @ApiOperation({
    summary: 'Compter les correspondances par interlocuteur, serveur et salon',
    description:
      'Totaux complets des DM et salons lisibles, sans contenu de message. Les groupes sans correspondance sont absents.',
  })
  searchSummary(
    @Req() req: AuthenticatedRequest,
    @Query() query: ResumeRechercheQueryDto,
  ): Promise<ResumeRecherche> {
    return this.recherche.resumer(req.auth, query.q);
  }

  @Get('search')
  @ApiOperation({
    summary: 'Recherche dans mes conversations',
    description:
      'DM et salons lisibles seulement, du plus récent au plus ancien, paginé par `cursor`.',
  })
  search(
    @Req() req: AuthenticatedRequest,
    @Query() query: RechercheQueryDto,
  ): Promise<PageRecherche> {
    return this.recherche.rechercher(req.auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: "Lit un DM dont je suis l'expéditeur ou le destinataire",
  })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<PrivateMessage> {
    return this.messages.findOne(req.auth.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Modifie un DM',
    description: 'Expéditeur seulement.',
  })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateMessageDto,
  ): Promise<PrivateMessage> {
    return this.messages.update(req.auth.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Supprime un DM',
    description: 'Expéditeur seulement.',
  })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    await this.messages.remove(req.auth.id, id);
    return { deleted: true };
  }
}
