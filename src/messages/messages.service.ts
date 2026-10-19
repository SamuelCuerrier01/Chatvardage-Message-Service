import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrivateMessage } from '@prisma/client';
import { LimiteEnvoiService } from '../limite-envoi.service';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import { ConversationSummary } from './dto/conversation-summary.dto';
import { CreateAdminMessageDto } from './dto/create-admin-message.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { DestinatairesService } from '../destinataires.service';
import { EtatLectureService } from '../lecture/etat-lecture.service';
import { AdminHistoryQueryDto, HistoryQueryDto } from './dto/history-query.dto';
import { UpdateMessageDto } from './dto/update-message.dto';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly limiteEnvoi: LimiteEnvoiService,
    private readonly destinataires: DestinatairesService,
    private readonly lecture: EtatLectureService,
  ) {}

  create(
    senderId: string,
    dto: CreateMessageDto,
    jeton: string,
  ): Promise<PrivateMessage> {
    return this.creer(senderId, dto, jeton);
  }

  async createForAdmin(
    dto: CreateAdminMessageDto,
    jeton: string,
    adminId: string,
  ): Promise<PrivateMessage> {
    await this.destinataires.exigerExistant(dto.senderId, jeton);
    return this.creer(dto.senderId, dto, jeton, (message) =>
      this.logger.log(
        `Admin ${adminId} a créé le DM ${message.id} au nom de ${dto.senderId}`,
      ),
    );
  }

  private async creer(
    senderId: string,
    dto: CreateMessageDto,
    jeton: string,
    auditer?: (message: PrivateMessage) => void,
  ): Promise<PrivateMessage> {
    this.limiteEnvoi.verifier(senderId);
    if (dto.recipientId === senderId) {
      throw new BadRequestException(
        'Impossible de s’envoyer un message privé à soi-même',
      );
    }
    await this.destinataires.exigerExistant(dto.recipientId, jeton);

    const message = await this.prisma.privateMessage.create({
      data: { senderId, recipientId: dto.recipientId, content: dto.content },
    });
    auditer?.(message);

    await this.redis.publish('private-message.created', message);
    return message;
  }

  async markDelivered(userId: string, id: string): Promise<PrivateMessage> {
    const message = await this.prisma.privateMessage.findUnique({
      where: { id },
    });
    if (!message) throw new NotFoundException('Message introuvable');
    if (message.recipientId !== userId)
      throw new ForbiddenException('Destinataire requis');
    if (message.deliveredAt) return message;
    const [delivered] = await this.prisma.$queryRaw<PrivateMessage[]>`
      UPDATE "PrivateMessage" SET "deliveredAt" = ${new Date()}
      WHERE "id" = ${id} AND "deliveredAt" IS NULL
      RETURNING *
    `;
    if (!delivered) {
      const actuel = await this.prisma.privateMessage.findUnique({
        where: { id },
      });
      if (!actuel) throw new NotFoundException('Message introuvable');
      return actuel;
    }
    await this.redis.publish('private-message.delivered', delivered);
    return delivered;
  }

  async history(
    userId: string,
    otherUserId: string,
    query: HistoryQueryDto,
  ): Promise<PrivateMessage[]> {
    if (
      (query.around && query.cursor) ||
      (query.direction === 'after' && (!query.cursor || query.around))
    ) {
      throw new BadRequestException('Pagination incompatible');
    }
    const anchor = query.around ?? query.cursor;
    if (anchor) {
      const cursorMessage = await this.prisma.privateMessage.findFirst({
        where: {
          id: anchor,
          OR: [
            { senderId: userId, recipientId: otherUserId },
            { senderId: otherUserId, recipientId: userId },
          ],
        },
        select: { id: true },
      });

      if (!cursorMessage) {
        throw new BadRequestException(
          'Curseur invalide pour cette conversation',
        );
      }
    }

    const messages = await this.prisma.privateMessage.findMany({
      where: {
        OR: [
          { senderId: userId, recipientId: otherUserId },
          { senderId: otherUserId, recipientId: userId },
        ],
      },
      ...(anchor ? { cursor: { id: anchor }, skip: query.around ? 0 : 1 } : {}),
      take: query.limit,
      orderBy: [
        { createdAt: query.direction === 'after' ? 'asc' : 'desc' },
        { id: query.direction === 'after' ? 'asc' : 'desc' },
      ],
    });

    return query.direction === 'after' ? messages : messages.reverse();
  }

  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const [envoyes, recus] = await Promise.all([
      this.prisma.privateMessage.groupBy({
        by: ['recipientId'],
        where: { senderId: userId },
        _max: { createdAt: true },
      }),
      this.prisma.privateMessage.groupBy({
        by: ['senderId'],
        where: { recipientId: userId },
        _max: { createdAt: true },
      }),
    ]);
    const derniereDate = new Map<string, Date>();
    const retenir = (autreId: string, date: Date | null) => {
      const actuelle = derniereDate.get(autreId);
      if (date && (!actuelle || date > actuelle)) {
        derniereDate.set(autreId, date);
      }
    };
    for (const ligne of envoyes)
      retenir(ligne.recipientId, ligne._max.createdAt);
    for (const ligne of recus) retenir(ligne.senderId, ligne._max.createdAt);
    if (derniereDate.size === 0) return [];

    const [derniers, nonLus] = await Promise.all([
      this.prisma.privateMessage.findMany({
        where: {
          OR: [...derniereDate].map(([autreId, createdAt]) => ({
            createdAt,
            OR: [
              { senderId: userId, recipientId: autreId },
              { senderId: autreId, recipientId: userId },
            ],
          })),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.lecture.compteursDm(userId),
    ]);

    const seen = new Set<string>();
    const conversations: ConversationSummary[] = [];

    for (const message of derniers) {
      const otherUserId =
        message.senderId === userId ? message.recipientId : message.senderId;

      if (seen.has(otherUserId)) continue;
      seen.add(otherUserId);

      conversations.push({
        otherUserId,
        lastMessage: message,
        unreadCount: nonLus.get(otherUserId) ?? 0,
      });
    }

    return conversations;
  }

  async supprimerUtilisateur(userId: string): Promise<number> {
    const { count } = await this.prisma.privateMessage.deleteMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
    });
    return count;
  }

  async findOne(userId: string, id: string): Promise<PrivateMessage> {
    const message = await this.prisma.privateMessage.findUnique({
      where: { id },
    });
    if (!message) throw new NotFoundException('Message introuvable');
    if (message.senderId !== userId && message.recipientId !== userId) {
      throw new ForbiddenException('Accès refusé');
    }
    return message;
  }

  async findAllForAdmin(
    query: AdminHistoryQueryDto,
  ): Promise<PrivateMessage[]> {
    const where = query.userId
      ? { OR: [{ senderId: query.userId }, { recipientId: query.userId }] }
      : {};
    if (query.cursor) {
      const cursorMessage = await this.prisma.privateMessage.findFirst({
        where: { id: query.cursor, ...where },
        select: { id: true },
      });
      if (!cursorMessage) throw new BadRequestException('Curseur invalide');
    }
    return this.prisma.privateMessage.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit,
    });
  }

  async update(
    senderId: string,
    id: string,
    dto: UpdateMessageDto,
  ): Promise<PrivateMessage> {
    const existing = await this.prisma.privateMessage.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Message introuvable');
    if (existing.senderId !== senderId) {
      throw new ForbiddenException(
        'Seul l’expéditeur peut modifier ce message',
      );
    }

    const message = await this.prisma.privateMessage.update({
      where: { id },
      data: { content: dto.content },
    });

    await this.redis.publish('private-message.updated', message);
    return message;
  }

  async remove(senderId: string, id: string): Promise<void> {
    const existing = await this.prisma.privateMessage.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Message introuvable');
    if (existing.senderId !== senderId) {
      throw new ForbiddenException(
        'Seul l’expéditeur peut supprimer ce message',
      );
    }

    await this.prisma.privateMessage.delete({ where: { id } });

    await this.redis.publish('private-message.deleted', {
      id: existing.id,
      senderId: existing.senderId,
      recipientId: existing.recipientId,
    });
  }

  async removeForAdmin(id: string, adminId: string): Promise<void> {
    const existing = await this.prisma.privateMessage.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Message introuvable');

    await this.prisma.privateMessage.delete({ where: { id } });
    this.logger.log(`Admin ${adminId} a supprimé le DM ${id}`);
    await this.redis.publish('private-message.deleted', {
      id: existing.id,
      senderId: existing.senderId,
      recipientId: existing.recipientId,
    });
  }
}
