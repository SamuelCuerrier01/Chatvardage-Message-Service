import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma, PrivateMessage, RoomMessage } from '@prisma/client';
import { idConversation } from '../lecture/etat-lecture.service';
import { PrismaService } from '../prisma.service';
import { Acteur, RoomsClientService } from '../rooms/rooms-client.service';
import { RechercheQueryDto } from './dto/recherche-query.dto';

export type ResultatRecherche =
  | { conversationId: string; kind: 'dm'; message: PrivateMessage }
  | { conversationId: string; kind: 'room'; message: RoomMessage };

export type PageRecherche = {
  results: ResultatRecherche[];
  nextCursor: string | null;
};

export type CompteConversation = { conversationId: string; count: number };
export type ResumeRecherche = {
  directMessages: CompteConversation[];
  servers: {
    serverId: string;
    count: number;
    channels: CompteConversation[];
  }[];
};

type Position = { createdAt: Date; id: string };

export const MESSAGE_BIENVENUE_ID = '00000000-0000-4000-8000-000000000101';

export const echapperMotif = (texte: string) =>
  texte.replace(/[\\%_]/g, (c) => `\\${c}`);

export const encoderCurseur = ({ createdAt, id }: Position) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

export function decoderCurseur(curseur: string): Position {
  const [date, id, ...reste] = Buffer.from(curseur, 'base64url')
    .toString()
    .split('|');
  const createdAt = new Date(date);
  if (!id || reste.length > 0 || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Curseur de recherche invalide');
  }
  return { createdAt, id };
}

const plusRecentDAbord = (a: Position, b: Position) =>
  b.createdAt.getTime() - a.createdAt.getTime() ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

type Portee = {
  dm: Prisma.PrivateMessageWhereInput | null;
  salonIds: string[];
};

@Injectable()
export class RechercheService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsClientService,
  ) {}

  async resumer(acteur: Acteur, texte: string): Promise<ResumeRecherche> {
    const lisibles = await this.rooms.salonsLisibles(acteur);
    const contenu = {
      contains: echapperMotif(texte),
      mode: 'insensitive' as const,
    };
    const [dms, salons] = await Promise.all([
      this.prisma.privateMessage.groupBy({
        by: ['senderId', 'recipientId'],
        where: {
          OR: [{ senderId: acteur.id }, { recipientId: acteur.id }],
          content: contenu,
        },
        _count: { _all: true },
      }),
      lisibles.length === 0
        ? Promise.resolve([])
        : this.prisma.roomMessage.groupBy({
            by: ['roomId'],
            where: {
              roomId: { in: lisibles.map((s) => s.salonId) },
              content: contenu,
              ...this.sansBienvenueTraduite(),
            },
            _count: { _all: true },
          }),
    ]);
    const personnes = new Map<string, number>();
    for (const dm of dms) {
      const id = idConversation(
        'dm',
        dm.senderId === acteur.id ? dm.recipientId : dm.senderId,
      );
      personnes.set(id, (personnes.get(id) ?? 0) + dm._count._all);
    }
    const serveurs = new Map<string, ResumeRecherche['servers'][number]>();
    const serveurParSalon = new Map(
      lisibles.map((s) => [s.salonId, s.serveurId]),
    );
    for (const salon of salons) {
      const serverId = serveurParSalon.get(salon.roomId)!;
      let serveur = serveurs.get(serverId);
      if (!serveur) {
        serveur = { serverId, count: 0, channels: [] };
        serveurs.set(serverId, serveur);
      }
      serveur.count += salon._count._all;
      serveur.channels.push({
        conversationId: idConversation('room', salon.roomId),
        count: salon._count._all,
      });
    }
    const trier = (a: CompteConversation, b: CompteConversation) =>
      b.count - a.count || a.conversationId.localeCompare(b.conversationId);
    return {
      directMessages: [...personnes]
        .map(([conversationId, count]) => ({ conversationId, count }))
        .sort(trier),
      servers: [...serveurs.values()]
        .map((s) => ({ ...s, channels: s.channels.sort(trier) }))
        .sort(
          (a, b) => b.count - a.count || a.serverId.localeCompare(b.serverId),
        ),
    };
  }

  async rechercher(
    acteur: Acteur,
    query: RechercheQueryDto,
  ): Promise<PageRecherche> {
    const apres = query.cursor ? decoderCurseur(query.cursor) : null;
    const contenu = {
      contains: echapperMotif(query.q),
      mode: 'insensitive' as const,
    };
    const avant = apres
      ? {
          OR: [
            { createdAt: { lt: apres.createdAt } },
            { createdAt: apres.createdAt, id: { lt: apres.id } },
          ],
        }
      : {};
    const ordre: Prisma.PrivateMessageOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];
    const take = query.limit + 1;

    const { dm, salonIds } = await this.portee(acteur, query.conversationId);
    const [dms, salons] = await Promise.all([
      dm === null
        ? Promise.resolve([])
        : this.prisma.privateMessage.findMany({
            where: { AND: [dm, avant], content: contenu },
            orderBy: ordre,
            take,
          }),
      salonIds.length === 0
        ? Promise.resolve([])
        : this.prisma.roomMessage.findMany({
            where: {
              roomId: { in: salonIds },
              content: contenu,
              ...avant,
              ...this.sansBienvenueTraduite(),
            },
            orderBy: ordre,
            take,
          }),
    ]);

    const fusion: ResultatRecherche[] = [
      ...dms.map((message): ResultatRecherche => ({
        conversationId: idConversation(
          'dm',
          message.senderId === acteur.id
            ? message.recipientId
            : message.senderId,
        ),
        kind: 'dm',
        message,
      })),
      ...salons.map((message): ResultatRecherche => ({
        conversationId: idConversation('room', message.roomId),
        kind: 'room',
        message,
      })),
    ].sort((a, b) => plusRecentDAbord(a.message, b.message));

    const results = fusion.slice(0, query.limit);
    return {
      results,
      nextCursor:
        fusion.length > query.limit
          ? encoderCurseur(results[results.length - 1].message)
          : null,
    };
  }

  private sansBienvenueTraduite(): Prisma.RoomMessageWhereInput {
    return {
      NOT: {
        id: MESSAGE_BIENVENUE_ID,
        updatedAt: { equals: this.prisma.roomMessage.fields.createdAt },
      },
    };
  }

  private async portee(
    acteur: Acteur,
    conversationId: string | undefined,
  ): Promise<Portee> {
    if (!conversationId) {
      const lisibles = await this.rooms.salonsLisibles(acteur);
      return {
        dm: { OR: [{ senderId: acteur.id }, { recipientId: acteur.id }] },
        salonIds: lisibles.map((s) => s.salonId),
      };
    }
    const [genre, cible] = conversationId.split(':');
    if (genre === 'dm') {
      return {
        dm: {
          OR: [
            { senderId: acteur.id, recipientId: cible },
            { senderId: cible, recipientId: acteur.id },
          ],
        },
        salonIds: [],
      };
    }
    const acces = await this.rooms.verifierAcces(cible, acteur);
    if (!acces.peutLire) {
      throw new ForbiddenException(
        'Vous devez être membre du salon pour consulter ce contenu',
      );
    }
    return { dm: null, salonIds: [cible] };
  }
}
