import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  EtatLectureService,
  LIMITE_LECTEURS_SALON,
  idConversation,
} from './etat-lecture.service';

describe('EtatLectureService', () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute));
  const moi = { id: 'moi', role: 'utilisateur' as const };
  let prisma: any;
  let rooms: any;
  let redis: any;
  let service: EtatLectureService;

  beforeEach(() => {
    prisma = {
      privateMessage: {
        findFirst: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      roomMessage: {
        findFirst: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      conversationReadState: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn(),
      },
    };
    rooms = {
      verifierAcces: jest.fn().mockResolvedValue({ peutLire: true }),
      salonsLisibles: jest.fn().mockResolvedValue([]),
    };
    redis = { publish: jest.fn() };
    service = new EtatLectureService(prisma, rooms, redis);
  });

  it('forme les identifiants de conversation du client mobile', () => {
    expect(idConversation('dm', 'u1')).toBe('dm:u1');
    expect(idConversation('room', 'r1')).toBe('room:r1');
  });

  describe('compteursDm', () => {
    it('compte les messages reçus après chaque lecture, et tous ceux des conversations jamais lues', async () => {
      prisma.conversationReadState.findMany.mockResolvedValue([
        { targetId: 'alice', lastReadAt: t(2) },
      ]);
      prisma.privateMessage.groupBy.mockResolvedValue([
        { senderId: 'alice', _count: { _all: 1 } },
        { senderId: 'bob', _count: { _all: 3 } },
      ]);

      await expect(service.compteursDm('moi')).resolves.toEqual(
        new Map([
          ['alice', 1],
          ['bob', 3],
        ]),
      );
      expect(prisma.conversationReadState.findMany).toHaveBeenCalledWith({
        where: { userId: 'moi', kind: 'dm' },
        select: { targetId: true, lastReadAt: true, lastReadMessageId: true },
      });
      expect(prisma.privateMessage.groupBy).toHaveBeenCalledWith({
        by: ['senderId'],
        where: {
          recipientId: 'moi',
          OR: [
            { senderId: 'alice', createdAt: { gt: t(2) } },
            { senderId: { notIn: ['alice'] } },
          ],
        },
        _count: { _all: true },
      });
    });

    it('se limite à un interlocuteur', async () => {
      await service.compteursDm('moi', 'alice');
      expect(prisma.conversationReadState.findMany).toHaveBeenCalledWith({
        where: { userId: 'moi', kind: 'dm', targetId: 'alice' },
        select: { targetId: true, lastReadAt: true, lastReadMessageId: true },
      });
      expect(prisma.privateMessage.groupBy.mock.calls[0][0].where).toEqual({
        recipientId: 'moi',
        senderId: 'alice',
        OR: [{ senderId: { notIn: [] } }],
      });
    });
  });

  it('compare aussi les identifiants des messages dans une même milliseconde', async () => {
    prisma.conversationReadState.findMany.mockResolvedValue([
      { targetId: 'alice', lastReadAt: t(2), lastReadMessageId: 'm1' },
    ]);
    await service.compteursDm('moi');
    expect(prisma.privateMessage.groupBy.mock.calls[0][0].where.OR[0]).toEqual({
      senderId: 'alice',
      OR: [{ createdAt: { gt: t(2) } }, { createdAt: t(2), id: { gt: 'm1' } }],
    });
  });

  describe('compteurs', () => {
    it('réunit DM et salons sous les identifiants du client mobile', async () => {
      prisma.privateMessage.groupBy.mockResolvedValue([
        { senderId: 'alice', _count: { _all: 2 } },
      ]);
      rooms.salonsLisibles.mockResolvedValue([
        { salonId: 'r1', serveurId: 's', depuis: t(0) },
      ]);
      prisma.roomMessage.groupBy.mockResolvedValue([
        { roomId: 'r1', _count: { _all: 5 } },
      ]);

      await expect(service.compteurs(moi)).resolves.toEqual({
        'dm:alice': 2,
        'room:r1': 5,
      });
      expect(rooms.salonsLisibles).toHaveBeenCalledWith(moi);
    });

    it('sans salon lisible, ne compte aucun message de salon', async () => {
      await expect(service.compteurs(moi)).resolves.toEqual({});
      expect(prisma.roomMessage.groupBy).not.toHaveBeenCalled();
    });

    it("compte depuis la plus récente entre la lecture et l'arrivée ; rien sans l'une ni l'autre", async () => {
      rooms.salonsLisibles.mockResolvedValue([
        { salonId: 'lu-apres', serveurId: 's', depuis: t(1) },
        { salonId: 'arrive-apres', serveurId: 's', depuis: t(9) },
        { salonId: 'lu-seulement', serveurId: 's', depuis: null },
        { salonId: 'arrive-seulement', serveurId: 's', depuis: t(4) },
        { salonId: 'inconnu', serveurId: 's', depuis: null },
      ]);
      prisma.conversationReadState.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { targetId: 'lu-apres', lastReadAt: t(5) },
          { targetId: 'arrive-apres', lastReadAt: t(3) },
          { targetId: 'lu-seulement', lastReadAt: t(7) },
        ]);

      await service.compteurs(moi);

      expect(prisma.roomMessage.groupBy).toHaveBeenCalledWith({
        by: ['roomId'],
        where: {
          authorId: { not: 'moi' },
          OR: [
            { roomId: 'lu-apres', createdAt: { gt: t(5) } },
            { roomId: 'arrive-apres', createdAt: { gt: t(9) } },
            { roomId: 'lu-seulement', createdAt: { gt: t(7) } },
            { roomId: 'arrive-seulement', createdAt: { gt: t(4) } },
          ],
        },
        _count: { _all: true },
      });
    });

    it('aucun seuil connu : aucune requête de messages de salon', async () => {
      rooms.salonsLisibles.mockResolvedValue([
        { salonId: 'r1', serveurId: 's', depuis: null },
      ]);
      await expect(service.compteurs(moi)).resolves.toEqual({});
      expect(prisma.roomMessage.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('activiteSalons', () => {
    it('donne la date du dernier message de chaque salon lisible', async () => {
      rooms.salonsLisibles.mockResolvedValue([
        { salonId: 'r1', serveurId: 's', depuis: null },
        { salonId: 'r2', serveurId: 's', depuis: null },
      ]);
      prisma.roomMessage.groupBy.mockResolvedValue([
        { roomId: 'r1', _max: { createdAt: new Date('2026-10-08T10:00:00Z') } },
        { roomId: 'r2', _max: { createdAt: null } },
      ]);
      await expect(service.activiteSalons(moi)).resolves.toEqual({
        'room:r1': '2026-10-08T10:00:00.000Z',
      });
      expect(prisma.roomMessage.groupBy).toHaveBeenCalledWith({
        by: ['roomId'],
        where: { roomId: { in: ['r1', 'r2'] } },
        _max: { createdAt: true },
      });
    });

    it('sans salon lisible, ne consulte pas les messages', async () => {
      await expect(service.activiteSalons(moi)).resolves.toEqual({});
      expect(prisma.roomMessage.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('marquerDmLu', () => {
    const conversation = {
      OR: [
        { senderId: 'moi', recipientId: 'alice' },
        { senderId: 'alice', recipientId: 'moi' },
      ],
    };

    it("avance jusqu'au dernier message sans jamais reculer", async () => {
      prisma.privateMessage.findFirst.mockResolvedValue({
        id: 'm2',
        createdAt: t(2),
      });
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(2),
      });
      prisma.privateMessage.groupBy.mockResolvedValue([
        { senderId: 'alice', _count: { _all: 1 } },
      ]);

      await expect(service.marquerDmLu('moi', 'alice')).resolves.toEqual({
        conversationId: 'dm:alice',
        lastReadAt: t(2),
        lastReadMessageId: null,
        unreadCount: 1,
      });
      expect(prisma.privateMessage.findFirst).toHaveBeenCalledWith({
        where: conversation,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, createdAt: true },
      });
      expect(prisma.conversationReadState.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 'moi',
            kind: 'dm',
            targetId: 'alice',
            lastReadAt: t(2),
            lastReadMessageId: 'm2',
          },
        ],
        skipDuplicates: true,
      });
      expect(prisma.conversationReadState.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'moi',
          kind: 'dm',
          targetId: 'alice',
          OR: [
            { lastReadAt: { lt: t(2) } },
            { lastReadAt: t(2), lastReadMessageId: { lt: 'm2' } },
          ],
        },
        data: { lastReadAt: t(2), lastReadMessageId: 'm2' },
      });
      expect(
        prisma.conversationReadState.findUniqueOrThrow,
      ).toHaveBeenCalledWith({
        where: {
          userId_kind_targetId: {
            userId: 'moi',
            kind: 'dm',
            targetId: 'alice',
          },
        },
        select: { lastReadAt: true, lastReadMessageId: true },
      });
    });

    it("cherche le message indiqué dans cette conversation ; ailleurs, c'est une 400", async () => {
      prisma.privateMessage.findFirst.mockResolvedValue(null);
      await expect(
        service.marquerDmLu('moi', 'alice', 'etranger'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.privateMessage.findFirst.mock.calls[0][0].where).toEqual({
        id: 'etranger',
        ...conversation,
      });
      expect(prisma.conversationReadState.createMany).not.toHaveBeenCalled();
    });

    it('conversation vide : ne marque rien et renvoie l’état existant', async () => {
      prisma.privateMessage.findFirst.mockResolvedValue(null);
      prisma.conversationReadState.findUnique.mockResolvedValueOnce({
        lastReadAt: t(1),
        lastReadMessageId: 'conserve',
      });
      await expect(service.marquerDmLu('moi', 'alice')).resolves.toEqual({
        conversationId: 'dm:alice',
        lastReadAt: t(1),
        lastReadMessageId: 'conserve',
        unreadCount: 0,
      });

      prisma.conversationReadState.findUnique.mockResolvedValueOnce(null);
      await expect(service.marquerDmLu('moi', 'alice')).resolves.toMatchObject({
        lastReadAt: null,
      });
      expect(prisma.conversationReadState.createMany).not.toHaveBeenCalled();
    });
  });

  it.each(['dm', 'room'])(
    'renvoie la position persistée complète du PUT %s',
    async (kind) => {
      prisma.privateMessage.findFirst.mockResolvedValue({
        id: 'm1',
        createdAt: t(2),
      });
      prisma.roomMessage.findFirst.mockResolvedValue({
        id: 'm1',
        createdAt: t(2),
      });
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(2),
        lastReadMessageId: 'm2',
      });
      const resultat =
        kind === 'dm'
          ? await service.marquerDmLu('moi', 'alice', 'm1')
          : await service.marquerSalonLu(moi, 'r1', 'm1');
      expect(resultat).toMatchObject({
        lastReadAt: t(2),
        lastReadMessageId: 'm2',
      });
    },
  );

  describe('marquerSalonLu', () => {
    it('exige la lecture du salon', async () => {
      rooms.verifierAcces.mockResolvedValue({ peutLire: false });
      await expect(service.marquerSalonLu(moi, 'r1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', moi);
      expect(prisma.roomMessage.findFirst).not.toHaveBeenCalled();
    });

    it("avance jusqu'au message indiqué du salon et recompte depuis l'arrivée", async () => {
      prisma.roomMessage.findFirst.mockResolvedValue({
        id: 'm3',
        createdAt: t(3),
      });
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(3),
      });
      rooms.salonsLisibles.mockResolvedValue([
        { salonId: 'r1', serveurId: 's', depuis: t(0) },
      ]);
      prisma.conversationReadState.findMany.mockResolvedValue([
        { targetId: 'r1', lastReadAt: t(3) },
      ]);
      prisma.roomMessage.groupBy.mockResolvedValue([
        { roomId: 'r1', _count: { _all: 2 } },
      ]);

      await expect(service.marquerSalonLu(moi, 'r1', 'm3')).resolves.toEqual({
        conversationId: 'room:r1',
        lastReadAt: t(3),
        lastReadMessageId: null,
        unreadCount: 2,
      });
      expect(prisma.roomMessage.findFirst.mock.calls[0][0].where).toEqual({
        id: 'm3',
        roomId: 'r1',
      });
      expect(prisma.roomMessage.groupBy.mock.calls[0][0].where.OR).toEqual([
        { roomId: 'r1', createdAt: { gt: t(3) } },
      ]);
    });

    it('salon absent de la liste (cache périmé) : compte depuis la lecture seule', async () => {
      prisma.roomMessage.findFirst.mockResolvedValue({
        id: 'm1',
        createdAt: t(1),
      });
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(1),
      });
      await expect(service.marquerSalonLu(moi, 'r1')).resolves.toMatchObject({
        unreadCount: 0,
      });
      expect(prisma.roomMessage.findFirst.mock.calls[0][0].where).toEqual({
        roomId: 'r1',
      });
    });
  });

  describe('accusés de lecture', () => {
    const message = { id: 'm2', createdAt: t(2) };

    beforeEach(() => {
      prisma.privateMessage.findFirst.mockResolvedValue(message);
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(2),
      });
    });

    it.each([
      ['créé', { count: 1 }, { count: 0 }],
      ['avancé', { count: 0 }, { count: 1 }],
    ])(
      'état %s : publié sur Redis après l’écriture',
      async (_cas, cree, avance) => {
        prisma.conversationReadState.createMany.mockResolvedValue(cree);
        prisma.conversationReadState.updateMany.mockResolvedValue(avance);
        await service.marquerDmLu('moi', 'alice');
        expect(redis.publish).toHaveBeenCalledWith('read-state.updated', {
          kind: 'dm',
          targetId: 'alice',
          userId: 'moi',
          lastReadAt: t(2).toISOString(),
          lastReadMessageId: null,
        });
      },
    );

    it('ne republie pas une lecture avancée par un appel concurrent', async () => {
      prisma.conversationReadState.createMany.mockResolvedValue({ count: 1 });
      prisma.conversationReadState.findUniqueOrThrow.mockResolvedValue({
        lastReadAt: t(4),
      });
      await expect(service.marquerDmLu('moi', 'alice')).resolves.toMatchObject({
        lastReadAt: t(4),
      });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('état inchangé (déjà lu plus loin) : rien n’est publié', async () => {
      await service.marquerDmLu('moi', 'alice');
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("lecteur d'un DM : l'état de l'interlocuteur sur cette conversation", async () => {
      prisma.conversationReadState.findUnique.mockResolvedValueOnce({
        lastReadAt: t(4),
        lastReadMessageId: 'm4',
      });
      await expect(service.lecteurDm('moi', 'alice')).resolves.toEqual({
        userId: 'alice',
        lastReadAt: t(4),
        lastReadMessageId: 'm4',
      });
      expect(prisma.conversationReadState.findUnique).toHaveBeenCalledWith({
        where: {
          userId_kind_targetId: {
            userId: 'alice',
            kind: 'dm',
            targetId: 'moi',
          },
        },
        select: { lastReadAt: true, lastReadMessageId: true },
      });
      prisma.conversationReadState.findUnique.mockResolvedValueOnce(null);
      await expect(service.lecteurDm('moi', 'bob')).resolves.toEqual({
        userId: 'bob',
        lastReadAt: null,
        lastReadMessageId: null,
      });
    });

    it("lecteurs d'un salon : les autres, plus récents d'abord, lecture requise", async () => {
      prisma.conversationReadState.findMany.mockResolvedValue(['l']);
      await expect(service.lecteursSalon(moi, 'r1')).resolves.toEqual(['l']);
      expect(prisma.conversationReadState.findMany).toHaveBeenCalledWith({
        where: { kind: 'room', targetId: 'r1', userId: { not: 'moi' } },
        select: { userId: true, lastReadAt: true, lastReadMessageId: true },
        orderBy: [{ lastReadAt: 'desc' }, { userId: 'asc' }],
        take: LIMITE_LECTEURS_SALON,
      });

      rooms.verifierAcces.mockResolvedValue({ peutLire: false });
      await expect(service.lecteursSalon(moi, 'r1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('efface les états d’un compte supprimé et de ses interlocuteurs', async () => {
    await service.supprimerUtilisateur('parti');
    expect(prisma.conversationReadState.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: 'parti' }, { kind: 'dm', targetId: 'parti' }] },
    });
  });

  it('efface les états des salons supprimés', async () => {
    await service.purgerSalons(['r1', 'r2']);
    expect(prisma.conversationReadState.deleteMany).toHaveBeenCalledWith({
      where: { kind: 'room', targetId: { in: ['r1', 'r2'] } },
    });
  });
});

it('publie la position complète du dernier message lu', async () => {
  const prisma: any = {
    privateMessage: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'm1', createdAt: new Date(1000) }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    conversationReadState: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        lastReadAt: new Date(1000),
        lastReadMessageId: 'm1',
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const redis: any = { publish: jest.fn() };
  await new EtatLectureService(prisma, {} as any, redis).marquerDmLu(
    'u1',
    'u2',
    'm1',
  );
  expect(redis.publish).toHaveBeenCalledWith(
    'read-state.updated',
    expect.objectContaining({ lastReadMessageId: 'm1' }),
  );
});
