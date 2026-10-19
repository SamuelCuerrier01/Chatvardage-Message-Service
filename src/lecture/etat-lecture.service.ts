import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConversationKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import { Acteur, RoomsClientService } from '../rooms/rooms-client.service';

export const CANAL_LECTURE = 'read-state.updated';

export const LIMITE_LECTEURS_SALON = 100;

export type EvenementLecture = {
  kind: ConversationKind;
  targetId: string;
  userId: string;
  lastReadAt: string;
  lastReadMessageId?: string | null;
};

export type Lecteur = {
  userId: string;
  lastReadAt: Date | null;
  lastReadMessageId: string | null;
};

export const idConversation = (kind: ConversationKind, targetId: string) =>
  `${kind}:${targetId}`;

export type EtatLecture = {
  conversationId: string;
  lastReadAt: Date | null;
  lastReadMessageId: string | null;
  unreadCount: number;
};

type Message = { id: string; createdAt: Date };
type PositionLecture = { lastReadAt: Date; lastReadMessageId?: string | null };

const apresLecture = (etat: PositionLecture) =>
  etat.lastReadMessageId
    ? {
        OR: [
          { createdAt: { gt: etat.lastReadAt } },
          { createdAt: etat.lastReadAt, id: { gt: etat.lastReadMessageId } },
        ],
      }
    : { createdAt: { gt: etat.lastReadAt } };

@Injectable()
export class EtatLectureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsClientService,
    private readonly redis: RedisService,
  ) {}

  async marquerDmLu(
    userId: string,
    otherUserId: string,
    messageId?: string,
  ): Promise<EtatLecture> {
    const conversation = {
      OR: [
        { senderId: userId, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: userId },
      ],
    };
    const message = await this.prisma.privateMessage.findFirst({
      where: messageId ? { id: messageId, ...conversation } : conversation,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
    const position = await this.avancer(
      userId,
      'dm',
      otherUserId,
      message,
      messageId,
    );
    const compteurs = await this.compteursDm(userId, otherUserId);
    return {
      conversationId: idConversation('dm', otherUserId),
      ...position,
      unreadCount: compteurs.get(otherUserId) ?? 0,
    };
  }

  async marquerSalonLu(
    acteur: Acteur,
    roomId: string,
    messageId?: string,
  ): Promise<EtatLecture> {
    const acces = await this.rooms.verifierAcces(roomId, acteur);
    if (!acces.peutLire) {
      throw new ForbiddenException(
        'Vous devez être membre du salon pour consulter ce contenu',
      );
    }
    const message = await this.prisma.roomMessage.findFirst({
      where: messageId ? { id: messageId, roomId } : { roomId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
    const position = await this.avancer(
      acteur.id,
      'room',
      roomId,
      message,
      messageId,
    );
    const salon = (await this.rooms.salonsLisibles(acteur)).find(
      (s) => s.salonId === roomId,
    );
    const compteurs = await this.compterSalons(acteur.id, [
      { salonId: roomId, depuis: salon?.depuis ?? null },
    ]);
    return {
      conversationId: idConversation('room', roomId),
      ...position,
      unreadCount: compteurs.get(roomId) ?? 0,
    };
  }

  async compteurs(acteur: Acteur): Promise<Record<string, number>> {
    const [dm, salons] = await Promise.all([
      this.compteursDm(acteur.id),
      this.rooms
        .salonsLisibles(acteur)
        .then((lisibles) => this.compterSalons(acteur.id, lisibles)),
    ]);
    const resultat: Record<string, number> = {};
    for (const [id, n] of dm) resultat[idConversation('dm', id)] = n;
    for (const [id, n] of salons) resultat[idConversation('room', id)] = n;
    return resultat;
  }

  async activiteSalons(acteur: Acteur): Promise<Record<string, string>> {
    const lisibles = await this.rooms.salonsLisibles(acteur);
    if (lisibles.length === 0) return {};
    const lignes = await this.prisma.roomMessage.groupBy({
      by: ['roomId'],
      where: { roomId: { in: lisibles.map((s) => s.salonId) } },
      _max: { createdAt: true },
    });
    const resultat: Record<string, string> = {};
    for (const ligne of lignes) {
      if (ligne._max.createdAt) {
        resultat[idConversation('room', ligne.roomId)] =
          ligne._max.createdAt.toISOString();
      }
    }
    return resultat;
  }

  async compteursDm(
    userId: string,
    seulement?: string,
  ): Promise<Map<string, number>> {
    const etats = await this.prisma.conversationReadState.findMany({
      where: {
        userId,
        kind: 'dm',
        ...(seulement ? { targetId: seulement } : {}),
      },
      select: { targetId: true, lastReadAt: true, lastReadMessageId: true },
    });
    const lignes = await this.prisma.privateMessage.groupBy({
      by: ['senderId'],
      where: {
        recipientId: userId,
        ...(seulement ? { senderId: seulement } : {}),
        OR: [
          ...etats.map((e) => ({
            senderId: e.targetId,
            ...apresLecture(e),
          })),
          { senderId: { notIn: etats.map((e) => e.targetId) } },
        ],
      },
      _count: { _all: true },
    });
    return new Map(lignes.map((l) => [l.senderId, l._count._all]));
  }

  async lecteurDm(userId: string, otherUserId: string): Promise<Lecteur> {
    const etat = await this.prisma.conversationReadState.findUnique({
      where: {
        userId_kind_targetId: {
          userId: otherUserId,
          kind: 'dm',
          targetId: userId,
        },
      },
      select: { lastReadAt: true, lastReadMessageId: true },
    });
    return {
      userId: otherUserId,
      lastReadAt: etat?.lastReadAt ?? null,
      lastReadMessageId: etat?.lastReadMessageId ?? null,
    };
  }

  async lecteursSalon(acteur: Acteur, roomId: string): Promise<Lecteur[]> {
    const acces = await this.rooms.verifierAcces(roomId, acteur);
    if (!acces.peutLire) {
      throw new ForbiddenException(
        'Vous devez être membre du salon pour consulter ce contenu',
      );
    }
    return this.prisma.conversationReadState.findMany({
      where: { kind: 'room', targetId: roomId, userId: { not: acteur.id } },
      select: { userId: true, lastReadAt: true, lastReadMessageId: true },
      orderBy: [{ lastReadAt: 'desc' }, { userId: 'asc' }],
      take: LIMITE_LECTEURS_SALON,
    });
  }

  async supprimerUtilisateur(userId: string): Promise<void> {
    await this.prisma.conversationReadState.deleteMany({
      where: { OR: [{ userId }, { kind: 'dm', targetId: userId }] },
    });
  }

  async purgerSalons(salonIds: string[]): Promise<void> {
    await this.prisma.conversationReadState.deleteMany({
      where: { kind: 'room', targetId: { in: salonIds } },
    });
  }

  private async compterSalons(
    userId: string,
    salons: { salonId: string; depuis: Date | null }[],
  ): Promise<Map<string, number>> {
    if (salons.length === 0) return new Map();
    const etats = await this.prisma.conversationReadState.findMany({
      where: {
        userId,
        kind: 'room',
        targetId: { in: salons.map((s) => s.salonId) },
      },
      select: { targetId: true, lastReadAt: true, lastReadMessageId: true },
    });
    const lus = new Map(etats.map((e) => [e.targetId, e]));

    const conditions: Prisma.RoomMessageWhereInput[] = [];
    for (const { salonId, depuis } of salons) {
      const lu = lus.get(salonId);
      if (lu && (!depuis || lu.lastReadAt >= depuis)) {
        conditions.push({ roomId: salonId, ...apresLecture(lu) });
      } else if (depuis) {
        conditions.push({ roomId: salonId, createdAt: { gt: depuis } });
      }
    }
    if (conditions.length === 0) return new Map();

    const lignes = await this.prisma.roomMessage.groupBy({
      by: ['roomId'],
      where: { authorId: { not: userId }, OR: conditions },
      _count: { _all: true },
    });
    return new Map(lignes.map((l) => [l.roomId, l._count._all]));
  }

  private async avancer(
    userId: string,
    kind: ConversationKind,
    targetId: string,
    message: Message | null,
    messageId: string | undefined,
  ): Promise<{ lastReadAt: Date | null; lastReadMessageId: string | null }> {
    const clef = { userId_kind_targetId: { userId, kind, targetId } };
    if (!message) {
      if (messageId) {
        throw new BadRequestException(
          'Message introuvable dans cette conversation',
        );
      }
      const etat = await this.prisma.conversationReadState.findUnique({
        where: clef,
        select: { lastReadAt: true, lastReadMessageId: true },
      });
      return {
        lastReadAt: etat?.lastReadAt ?? null,
        lastReadMessageId: etat?.lastReadMessageId ?? null,
      };
    }

    const cree = await this.prisma.conversationReadState.createMany({
      data: [
        {
          userId,
          kind,
          targetId,
          lastReadAt: message.createdAt,
          lastReadMessageId: message.id,
        },
      ],
      skipDuplicates: true,
    });
    const avance = await this.prisma.conversationReadState.updateMany({
      where: {
        userId,
        kind,
        targetId,
        OR: [
          { lastReadAt: { lt: message.createdAt } },
          {
            lastReadAt: message.createdAt,
            lastReadMessageId: { lt: message.id },
          },
        ],
      },
      data: { lastReadAt: message.createdAt, lastReadMessageId: message.id },
    });
    const etat = await this.prisma.conversationReadState.findUniqueOrThrow({
      where: clef,
      select: { lastReadAt: true, lastReadMessageId: true },
    });
    if (
      (cree.count > 0 || avance.count > 0) &&
      etat.lastReadAt.getTime() === message.createdAt.getTime()
    ) {
      const evenement: EvenementLecture = {
        kind,
        targetId,
        userId,
        lastReadAt: etat.lastReadAt.toISOString(),
        lastReadMessageId: etat.lastReadMessageId ?? null,
      };
      await this.redis.publierApresEcriture(CANAL_LECTURE, evenement);
    }
    return {
      lastReadAt: etat.lastReadAt,
      lastReadMessageId: etat.lastReadMessageId ?? null,
    };
  }
}
