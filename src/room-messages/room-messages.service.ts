import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RoomMessage } from '@prisma/client';
import { LimiteEnvoiService } from '../limite-envoi.service';
import { DestinatairesService } from '../destinataires.service';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import {
  AccesSalon,
  Acteur,
  RoomsClientService,
} from '../rooms/rooms-client.service';
import { CreateAdminRoomMessageDto } from './dto/create-admin-room-message.dto';
import { CreateRoomMessageDto } from './dto/create-room-message.dto';
import { RoomHistoryQueryDto } from './dto/room-history-query.dto';
import { UpdateRoomMessageDto } from './dto/update-room-message.dto';

@Injectable()
export class RoomMessagesService {
  private readonly logger = new Logger(RoomMessagesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly rooms: RoomsClientService,
    private readonly limiteEnvoi: LimiteEnvoiService,
    private readonly destinataires: DestinatairesService,
  ) {}

  async create(
    acteur: Acteur,
    roomId: string,
    dto: CreateRoomMessageDto,
  ): Promise<RoomMessage> {
    this.limiteEnvoi.verifier(acteur.id);
    const acces = await this.rooms.verifierAcces(roomId, acteur);
    this.exigerLecture(acces.peutLire, 'y envoyer un message');
    if (!acces.peutEcrire) {
      throw new ForbiddenException(
        'Seuls les modérateurs peuvent écrire dans ce salon',
      );
    }

    const message = await this.prisma.roomMessage.create({
      data: { roomId, authorId: acteur.id, content: dto.content },
    });

    await this.redis.publish('room-message.created', message);
    return message;
  }

  async createForAdmin(
    acteur: Acteur,
    roomId: string,
    dto: CreateAdminRoomMessageDto,
    jeton: string,
  ): Promise<RoomMessage> {
    const roleAuteur = await this.destinataires.roleDe(dto.authorId, jeton);
    const acces = await this.rooms.verifierAcces(roomId, acteur);
    this.exigerLecture(acces.peutLire, 'y envoyer un message');
    if (!acces.peutEcrire) {
      throw new ForbiddenException(
        'Seuls les modérateurs peuvent écrire dans ce salon',
      );
    }

    const accesAuteur = await this.rooms.verifierAcces(roomId, {
      id: dto.authorId,
      role: roleAuteur,
    });
    if (
      !accesAuteur.estMembre ||
      !accesAuteur.peutLire ||
      !accesAuteur.peutEcrire
    ) {
      throw new ForbiddenException(
        'Auteur sans droit d’écriture dans ce salon',
      );
    }
    this.limiteEnvoi.verifier(dto.authorId);

    const message = await this.prisma.roomMessage.create({
      data: { roomId, authorId: dto.authorId, content: dto.content },
    });

    this.logger.log(
      `Admin ${acteur.id} a créé le message ${message.id} dans le salon ${roomId} au nom de ${dto.authorId}`,
    );
    await this.redis.publish('room-message.created', message);
    return message;
  }

  async history(
    acteur: Acteur,
    roomId: string,
    query: RoomHistoryQueryDto,
  ): Promise<RoomMessage[]> {
    await this.verifierLecture(acteur, roomId);

    if (
      (query.around && query.cursor) ||
      (query.direction === 'after' && (!query.cursor || query.around))
    ) {
      throw new BadRequestException('Pagination incompatible');
    }
    const anchor = query.around ?? query.cursor;
    if (anchor) {
      const cursorMessage = await this.prisma.roomMessage.findFirst({
        where: { id: anchor, roomId },
        select: { id: true },
      });

      if (!cursorMessage) {
        throw new BadRequestException('Curseur invalide pour ce salon');
      }
    }

    const messages = await this.prisma.roomMessage.findMany({
      where: { roomId },
      ...(anchor ? { cursor: { id: anchor }, skip: query.around ? 0 : 1 } : {}),
      take: query.limit,
      orderBy: [
        { createdAt: query.direction === 'after' ? 'asc' : 'desc' },
        { id: query.direction === 'after' ? 'asc' : 'desc' },
      ],
    });

    return query.direction === 'after' ? messages : messages.reverse();
  }

  async findOne(
    acteur: Acteur,
    roomId: string,
    id: string,
  ): Promise<RoomMessage> {
    await this.verifierLecture(acteur, roomId);

    const message = await this.prisma.roomMessage.findUnique({
      where: { id },
    });
    if (!message || message.roomId !== roomId) {
      throw new NotFoundException('Message introuvable');
    }
    return message;
  }

  async update(
    acteur: Acteur,
    roomId: string,
    id: string,
    dto: UpdateRoomMessageDto,
  ): Promise<RoomMessage> {
    await this.verifierLecture(acteur, roomId);
    const existing = await this.prisma.roomMessage.findUnique({
      where: { id },
    });
    if (!existing || existing.roomId !== roomId) {
      throw new NotFoundException('Message introuvable');
    }
    if (existing.authorId !== acteur.id) {
      throw new ForbiddenException("Seul l'auteur peut modifier ce message");
    }

    const message = await this.prisma.roomMessage.update({
      where: { id },
      data: { content: dto.content },
    });

    await this.redis.publish('room-message.updated', message);
    return message;
  }

  async remove(acteur: Acteur, roomId: string, id: string): Promise<void> {
    const acces = await this.verifierLecture(acteur, roomId);
    const existing = await this.prisma.roomMessage.findUnique({
      where: { id },
    });
    if (!existing || existing.roomId !== roomId) {
      throw new NotFoundException('Message introuvable');
    }
    if (existing.authorId !== acteur.id && !acces.peutModerer) {
      throw new ForbiddenException(
        "Seuls l'auteur et les modérateurs peuvent supprimer ce message",
      );
    }

    await this.prisma.roomMessage.delete({ where: { id } });

    await this.redis.publish('room-message.deleted', {
      id: existing.id,
      roomId: existing.roomId,
      authorId: existing.authorId,
    });
  }

  async purgerSalons(salonIds: string[]): Promise<number> {
    const { count } = await this.prisma.roomMessage.deleteMany({
      where: { roomId: { in: salonIds } },
    });
    return count;
  }

  async supprimerAuteur(authorId: string): Promise<number> {
    const { count } = await this.prisma.roomMessage.deleteMany({
      where: { authorId },
    });
    return count;
  }

  private async verifierLecture(
    acteur: Acteur,
    roomId: string,
  ): Promise<AccesSalon> {
    const acces = await this.rooms.verifierAcces(roomId, acteur);
    this.exigerLecture(acces.peutLire, 'consulter ce contenu');
    return acces;
  }

  private exigerLecture(peutLire: boolean, verb: string): void {
    if (!peutLire) {
      throw new ForbiddenException(
        `Vous devez être membre du salon pour ${verb}`,
      );
    }
  }
}
