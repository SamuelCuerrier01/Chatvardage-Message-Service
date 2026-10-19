import { PrismaClient } from '@prisma/client';
import { EtatLectureService } from '../../src/lecture/etat-lecture.service';
import type { PrismaService } from '../../src/prisma.service';
import { RechercheService } from '../../src/recherche/recherche.service';
import type { RedisService } from '../../src/redis.service';
import type {
  Acteur,
  RoomsClientService,
  SalonLisible,
} from '../../src/rooms/rooms-client.service';

const url = process.env.DATABASE_URL ?? '';
if (!/\/[^/?]+_test(\?|$)/.test(url)) {
  throw new Error(
    'DATABASE_URL doit désigner une base jetable dont le nom finit par _test',
  );
}

const MOI = '00000000-0000-4000-8000-00000000000a';
const ALICE = '00000000-0000-4000-8000-00000000000b';
const BOB = '00000000-0000-4000-8000-00000000000c';
const SALON = '00000000-0000-4000-8000-0000000000d1';
const SALON_INTERDIT = '00000000-0000-4000-8000-0000000000d2';
const moi: Acteur = { id: MOI, role: 'utilisateur' };

const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute, 0, 0));

const publies: unknown[][] = [];
const redisSimule = {
  publish: (...args: unknown[]) => {
    publies.push(args);
    return Promise.resolve(1);
  },
} as unknown as RedisService;

function roomsSimule(salons: SalonLisible[]): RoomsClientService {
  return {
    salonsLisibles: () => Promise.resolve(salons),
    verifierAcces: (roomId: string) =>
      Promise.resolve({
        salonId: roomId,
        serveurId: 'srv',
        estMembre: true,
        peutLire: salons.some((s) => s.salonId === roomId),
        peutEcrire: true,
        peutModerer: false,
      }),
  } as unknown as RoomsClientService;
}

describe('non-lus, état de lecture et recherche (PostgreSQL réel)', () => {
  let prisma: PrismaClient;
  const salons: SalonLisible[] = [
    { salonId: SALON, serveurId: 'srv', depuis: t(10) },
  ];

  const dm = (
    senderId: string,
    recipientId: string,
    minute: number,
    content = 'salut',
  ) =>
    prisma.privateMessage.create({
      data: { senderId, recipientId, content, createdAt: t(minute) },
    });
  const salon = (
    roomId: string,
    authorId: string,
    minute: number,
    content = 'bonjour',
  ) =>
    prisma.roomMessage.create({
      data: { roomId, authorId, content, createdAt: t(minute) },
    });
  const services = (client: PrismaClient) => ({
    lecture: new EtatLectureService(
      client as PrismaService,
      roomsSimule(salons),
      redisSimule,
    ),
    recherche: new RechercheService(
      client as PrismaService,
      roomsSimule(salons),
    ),
  });

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    publies.length = 0;
    await prisma.$executeRawUnsafe(
      'TRUNCATE "PrivateMessage", "RoomMessage", "ConversationReadState"',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('compte toutes les correspondances par personne et salon, avec les droits et les jokers littéraux', async () => {
    await dm(MOI, ALICE, 1, 'budget 50%_');
    await dm(ALICE, MOI, 2, 'BUDGET 50%_');
    await dm(BOB, MOI, 3, 'budget 50%_');
    await dm(ALICE, BOB, 4, 'budget 50%_');
    await dm(MOI, ALICE, 5, 'budget 5000');
    await salon(SALON, ALICE, 6, 'budget 50%_');
    await salon(SALON_INTERDIT, ALICE, 7, 'budget 50%_');
    const { recherche } = services(prisma);
    expect(await recherche.resumer(moi, '50%_')).toEqual({
      directMessages: [
        { conversationId: `dm:${ALICE}`, count: 2 },
        { conversationId: `dm:${BOB}`, count: 1 },
      ],
      servers: [
        {
          serverId: 'srv',
          count: 1,
          channels: [{ conversationId: `room:${SALON}`, count: 1 }],
        },
      ],
    });
    expect(await recherche.resumer(moi, 'absent')).toEqual({
      directMessages: [],
      servers: [],
    });
  });

  it('distingue les messages à date égale en DM et salon, sans recul', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    for (const id of ids) {
      await prisma.privateMessage.create({
        data: {
          id,
          senderId: ALICE,
          recipientId: MOI,
          content: 'dm',
          createdAt: t(20),
        },
      });
      await prisma.roomMessage.create({
        data: {
          id,
          roomId: SALON,
          authorId: ALICE,
          content: 'salon',
          createdAt: t(20),
        },
      });
    }
    const { lecture } = services(prisma);
    expect((await lecture.marquerDmLu(MOI, ALICE, ids[0])).unreadCount).toBe(1);
    expect((await lecture.marquerSalonLu(moi, SALON, ids[0])).unreadCount).toBe(
      1,
    );
    expect((await lecture.lecteurDm(ALICE, MOI)).lastReadMessageId).toBe(
      ids[0],
    );
    expect(
      (
        await lecture.lecteursSalon({ id: ALICE, role: 'utilisateur' }, SALON)
      )[0].lastReadMessageId,
    ).toBe(ids[0]);
    expect(publies[0][1]).toMatchObject({ lastReadMessageId: ids[0] });
    expect((await lecture.marquerDmLu(MOI, ALICE, ids[1])).unreadCount).toBe(0);
    expect((await lecture.marquerSalonLu(moi, SALON, ids[1])).unreadCount).toBe(
      0,
    );
    expect(await lecture.marquerDmLu(MOI, ALICE, ids[0])).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: ids[1],
    });
    expect(await lecture.marquerSalonLu(moi, SALON, ids[0])).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: ids[1],
    });
  });

  it('compte les DM reçus après la dernière lecture, jamais les siens', async () => {
    await dm(ALICE, MOI, 1);
    const lu = await dm(ALICE, MOI, 2);
    await dm(MOI, ALICE, 3);
    await dm(ALICE, MOI, 4);
    await dm(BOB, MOI, 5);
    await dm(BOB, MOI, 6);
    const { lecture } = services(prisma);

    expect(await lecture.compteurs(moi)).toEqual({
      [`dm:${ALICE}`]: 3,
      [`dm:${BOB}`]: 2,
    });

    await expect(lecture.marquerDmLu(MOI, ALICE, lu.id)).resolves.toMatchObject(
      { lastReadAt: t(2), unreadCount: 1 },
    );
    expect(await lecture.compteurs(moi)).toEqual({
      [`dm:${ALICE}`]: 1,
      [`dm:${BOB}`]: 2,
    });

    await lecture.marquerDmLu(MOI, ALICE);
    expect(await lecture.compteurs(moi)).toEqual({ [`dm:${BOB}`]: 2 });
  });

  it("l'état ne recule jamais et refuse un message d'une autre conversation", async () => {
    const ancien = await dm(ALICE, MOI, 1);
    await dm(ALICE, MOI, 2);
    const autre = await dm(BOB, MOI, 3);
    const { lecture } = services(prisma);

    await lecture.marquerDmLu(MOI, ALICE);
    await expect(
      lecture.marquerDmLu(MOI, ALICE, ancien.id),
    ).resolves.toMatchObject({ lastReadAt: t(2), unreadCount: 0 });
    await expect(lecture.marquerDmLu(MOI, ALICE, autre.id)).rejects.toThrow(
      'Message introuvable dans cette conversation',
    );
  });

  it("salon : ne compte qu'après l'arrivée dans le serveur, ni ses propres messages", async () => {
    await salon(SALON, ALICE, 5);
    await salon(SALON, ALICE, 11);
    await salon(SALON, MOI, 12);
    const lu = await salon(SALON, BOB, 13);
    await salon(SALON, ALICE, 14);
    await salon(SALON_INTERDIT, ALICE, 15);
    const { lecture } = services(prisma);

    expect(await lecture.compteurs(moi)).toEqual({ [`room:${SALON}`]: 3 });
    await expect(
      lecture.marquerSalonLu(moi, SALON, lu.id),
    ).resolves.toMatchObject({ lastReadAt: t(13), unreadCount: 1 });
    await expect(lecture.marquerSalonLu(moi, SALON_INTERDIT)).rejects.toThrow(
      'membre du salon',
    );
  });

  it('accusés de lecture : état des autres, publié seulement quand il avance', async () => {
    await dm(ALICE, MOI, 1);
    const reponse = await dm(MOI, ALICE, 2);
    const messageSalon = await salon(SALON, MOI, 11);
    const lectureAlice = new EtatLectureService(
      prisma as PrismaService,
      roomsSimule(salons),
      redisSimule,
    );
    const { lecture } = services(prisma);

    await expect(lecture.lecteurDm(MOI, ALICE)).resolves.toEqual({
      userId: ALICE,
      lastReadAt: null,
      lastReadMessageId: null,
    });
    await lectureAlice.marquerDmLu(ALICE, MOI);
    await expect(lecture.lecteurDm(MOI, ALICE)).resolves.toEqual({
      userId: ALICE,
      lastReadAt: reponse.createdAt,
      lastReadMessageId: reponse.id,
    });
    expect(publies).toEqual([
      [
        'read-state.updated',
        {
          kind: 'dm',
          targetId: MOI,
          userId: ALICE,
          lastReadAt: reponse.createdAt.toISOString(),
          lastReadMessageId: reponse.id,
        },
      ],
    ]);
    await lectureAlice.marquerDmLu(ALICE, MOI);
    expect(publies).toHaveLength(1);

    await lectureAlice.marquerSalonLu(
      { id: ALICE, role: 'utilisateur' },
      SALON,
    );
    await lecture.marquerSalonLu(moi, SALON);
    await expect(lecture.lecteursSalon(moi, SALON)).resolves.toEqual([
      { userId: ALICE, lastReadAt: t(11), lastReadMessageId: messageSalon.id },
    ]);
  });

  it('les compteurs sont identiques après un redémarrage du service', async () => {
    await dm(ALICE, MOI, 1);
    const lu = await dm(ALICE, MOI, 2);
    await dm(ALICE, MOI, 3);
    await salon(SALON, ALICE, 11);
    await salon(SALON, ALICE, 12);
    await services(prisma).lecture.marquerDmLu(MOI, ALICE, lu.id);
    await services(prisma).lecture.marquerSalonLu(moi, SALON);
    const avant = await services(prisma).lecture.compteurs(moi);

    const apresRedemarrage = new PrismaClient();
    try {
      await expect(
        services(apresRedemarrage).lecture.compteurs(moi),
      ).resolves.toEqual(avant);
      expect(avant).toEqual({ [`dm:${ALICE}`]: 1 });
    } finally {
      await apresRedemarrage.$disconnect();
    }
  });

  it('les effacements internes retirent les états concernés', async () => {
    await dm(ALICE, MOI, 1);
    await salon(SALON, ALICE, 11);
    const { lecture } = services(prisma);
    await lecture.marquerDmLu(MOI, ALICE);
    await lecture.marquerDmLu(ALICE, MOI);
    await lecture.marquerSalonLu(moi, SALON);

    await lecture.supprimerUtilisateur(ALICE);
    await lecture.purgerSalons([SALON]);
    expect(await prisma.conversationReadState.count()).toBe(0);
  });

  it('recherche sans casse, dans les seules conversations accessibles', async () => {
    await dm(ALICE, MOI, 1, 'Le Projet avance');
    await dm(ALICE, BOB, 2, 'projet secret entre Alice et Bob');
    await salon(SALON, ALICE, 3, 'réunion projet demain');
    await salon(SALON_INTERDIT, ALICE, 4, 'projet du salon interdit');
    await dm(MOI, ALICE, 5, 'rien à voir');
    const { recherche } = services(prisma);

    const page = await recherche.rechercher(moi, { q: 'PROJET', limit: 20 });
    expect(page.nextCursor).toBeNull();
    expect(
      page.results.map((r) => [r.conversationId, r.message.content]),
    ).toEqual([
      [`room:${SALON}`, 'réunion projet demain'],
      [`dm:${ALICE}`, 'Le Projet avance'],
    ]);
  });

  it('limitée à une conversation : ni les autres DM ni les autres salons', async () => {
    await dm(ALICE, MOI, 1, 'projet avec Alice');
    await dm(BOB, MOI, 2, 'projet avec Bob');
    await salon(SALON, ALICE, 3, 'projet du salon');
    await salon(SALON_INTERDIT, ALICE, 4, 'projet interdit');
    const { recherche } = services(prisma);
    const contenus = async (conversationId: string) =>
      (
        await recherche.rechercher(moi, {
          q: 'projet',
          limit: 20,
          conversationId,
        })
      ).results.map((r) => r.message.content);

    expect(await contenus(`dm:${ALICE}`)).toEqual(['projet avec Alice']);
    expect(await contenus(`room:${SALON}`)).toEqual(['projet du salon']);
    await expect(contenus(`room:${SALON_INTERDIT}`)).rejects.toThrow(
      'membre du salon',
    );
  });

  it('prend % et _ littéralement', async () => {
    await dm(ALICE, MOI, 1, 'remise de 50% ce soir');
    await dm(ALICE, MOI, 2, 'remise de 50 dollars');
    await dm(ALICE, MOI, 3, 'nom_de_fichier');
    await dm(ALICE, MOI, 4, 'nomXdeXfichier');
    const { recherche } = services(prisma);

    const pourcent = await recherche.rechercher(moi, { q: '50%', limit: 20 });
    expect(pourcent.results.map((r) => r.message.content)).toEqual([
      'remise de 50% ce soir',
    ]);
    const souligne = await recherche.rechercher(moi, {
      q: 'nom_de',
      limit: 20,
    });
    expect(souligne.results.map((r) => r.message.content)).toEqual([
      'nom_de_fichier',
    ]);
  });

  it('pagine DM et salons ensemble, sans doublon ni trou', async () => {
    for (let i = 0; i < 5; i += 1) {
      await dm(ALICE, MOI, 20 + 2 * i, `mot ${i}`);
      await salon(SALON, ALICE, 21 + 2 * i, `mot salon ${i}`);
    }
    await dm(BOB, MOI, 40, 'mot égalité A');
    await dm(BOB, MOI, 40, 'mot égalité B');
    const { recherche } = services(prisma);

    const vus: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await recherche.rechercher(moi, {
        q: 'mot',
        limit: 3,
        cursor,
      });
      vus.push(...page.results.map((r) => r.message.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(vus).toHaveLength(12);
    expect(new Set(vus).size).toBe(12);
  });
});
