import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RechercheQueryDto } from './dto/recherche-query.dto';
import {
  MESSAGE_BIENVENUE_ID,
  RechercheService,
  decoderCurseur,
  echapperMotif,
  encoderCurseur,
} from './recherche.service';

describe('RechercheService', () => {
  const t = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute));
  const moi = { id: 'moi', role: 'utilisateur' as const };
  const dm = (id: string, minute: number, senderId = 'alice') => ({
    id,
    senderId,
    recipientId: senderId === 'moi' ? 'alice' : 'moi',
    content: 'projet',
    createdAt: t(minute),
    updatedAt: t(minute),
  });
  const salon = (id: string, minute: number) => ({
    id,
    roomId: 'r1',
    authorId: 'bob',
    content: 'projet',
    createdAt: t(minute),
    updatedAt: t(minute),
  });
  let prisma: any;
  let rooms: any;
  let service: RechercheService;

  beforeEach(() => {
    prisma = {
      privateMessage: { findMany: jest.fn().mockResolvedValue([]) },
      roomMessage: {
        findMany: jest.fn().mockResolvedValue([]),
        fields: { createdAt: 'champ createdAt' },
      },
    };
    rooms = {
      verifierAcces: jest.fn().mockResolvedValue({ peutLire: true }),
      salonsLisibles: jest
        .fn()
        .mockResolvedValue([{ salonId: 'r1', serveurId: 's', depuis: null }]),
    };
    service = new RechercheService(prisma, rooms);
  });

  it('cherche dans mes DM et mes salons lisibles seulement, sans casse et sans jokers', async () => {
    await service.rechercher(moi, { q: '50%_\\', limit: 20 });

    const contenu = { contains: '50\\%\\_\\\\', mode: 'insensitive' };
    const ordre = [{ createdAt: 'desc' }, { id: 'desc' }];
    expect(rooms.salonsLisibles).toHaveBeenCalledWith(moi);
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith({
      where: {
        AND: [{ OR: [{ senderId: 'moi' }, { recipientId: 'moi' }] }, {}],
        content: contenu,
      },
      orderBy: ordre,
      take: 21,
    });
    expect(prisma.roomMessage.findMany).toHaveBeenCalledWith({
      where: {
        roomId: { in: ['r1'] },
        content: contenu,
        NOT: {
          id: MESSAGE_BIENVENUE_ID,
          updatedAt: { equals: 'champ createdAt' },
        },
      },
      orderBy: ordre,
      take: 21,
    });
  });

  it('sans salon lisible, ne cherche que dans les DM', async () => {
    rooms.salonsLisibles.mockResolvedValue([]);
    await expect(
      service.rechercher(moi, { q: 'projet', limit: 20 }),
    ).resolves.toEqual({ results: [], nextCursor: null });
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
  });

  it("fusionne du plus récent au plus ancien et donne l'interlocuteur de chaque DM", async () => {
    const recu = dm('d1', 5);
    const envoye = dm('d2', 3, 'moi');
    const ecrit = salon('s1', 4);
    prisma.privateMessage.findMany.mockResolvedValue([recu, envoye]);
    prisma.roomMessage.findMany.mockResolvedValue([ecrit]);

    await expect(
      service.rechercher(moi, { q: 'projet', limit: 20 }),
    ).resolves.toEqual({
      results: [
        { conversationId: 'dm:alice', kind: 'dm', message: recu },
        { conversationId: 'room:r1', kind: 'room', message: ecrit },
        { conversationId: 'dm:alice', kind: 'dm', message: envoye },
      ],
      nextCursor: null,
    });
  });

  it('départage les messages de la même milliseconde par identifiant décroissant', async () => {
    prisma.privateMessage.findMany.mockResolvedValue([dm('a', 1), dm('c', 1)]);
    prisma.roomMessage.findMany.mockResolvedValue([
      salon('b', 1),
      salon('b', 1),
    ]);
    const page = await service.rechercher(moi, { q: 'projet', limit: 20 });
    expect(page.results.map((r) => r.message.id)).toEqual(['c', 'b', 'b', 'a']);
  });

  it('donne un curseur quand il reste des résultats, et repart de cette position', async () => {
    prisma.privateMessage.findMany.mockResolvedValue([
      dm('d3', 3),
      dm('d1', 1),
    ]);
    prisma.roomMessage.findMany.mockResolvedValue([salon('s2', 2)]);

    const page = await service.rechercher(moi, { q: 'projet', limit: 2 });
    expect(page.results.map((r) => r.message.id)).toEqual(['d3', 's2']);
    expect(page.nextCursor).toBe(encoderCurseur({ createdAt: t(2), id: 's2' }));

    prisma.privateMessage.findMany.mockClear();
    await service.rechercher(moi, {
      q: 'projet',
      limit: 2,
      cursor: page.nextCursor!,
    });
    const avant = {
      OR: [{ createdAt: { lt: t(2) } }, { createdAt: t(2), id: { lt: 's2' } }],
    };
    expect(
      prisma.privateMessage.findMany.mock.calls[0][0].where.AND[1],
    ).toEqual(avant);
    expect(prisma.roomMessage.findMany.mock.calls[1][0].where).toMatchObject(
      avant,
    );
  });

  it.each([
    ['sans identifiant', Buffer.from(t(1).toISOString()).toString('base64url')],
    ['date invalide', Buffer.from('hier|m1').toString('base64url')],
    [
      'trop de parties',
      Buffer.from(`${t(1).toISOString()}|a|b`).toString('base64url'),
    ],
  ])('refuse un curseur %s (400)', async (_cas, cursor) => {
    await expect(
      service.rechercher(moi, { q: 'projet', limit: 20, cursor }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(() => decoderCurseur(cursor)).toThrow(
      'Curseur de recherche invalide',
    );
  });

  it('limitée à un DM : seulement les messages échangés avec cet interlocuteur', async () => {
    await service.rechercher(moi, {
      q: 'projet',
      limit: 20,
      conversationId: 'dm:alice',
    });
    expect(
      prisma.privateMessage.findMany.mock.calls[0][0].where.AND[0],
    ).toEqual({
      OR: [
        { senderId: 'moi', recipientId: 'alice' },
        { senderId: 'alice', recipientId: 'moi' },
      ],
    });
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
    expect(rooms.salonsLisibles).not.toHaveBeenCalled();
    expect(rooms.verifierAcces).not.toHaveBeenCalled();
  });

  it('limitée à un salon : droit de lecture vérifié, ni DM ni autres salons', async () => {
    await service.rechercher(moi, {
      q: 'projet',
      limit: 20,
      conversationId: 'room:r9',
    });
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r9', moi);
    expect(prisma.roomMessage.findMany.mock.calls[0][0].where.roomId).toEqual({
      in: ['r9'],
    });
    expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
    expect(rooms.salonsLisibles).not.toHaveBeenCalled();
  });

  it('salon illisible : 403, sans rien chercher', async () => {
    rooms.verifierAcces.mockResolvedValue({ peutLire: false });
    await expect(
      service.rechercher(moi, {
        q: 'projet',
        limit: 20,
        conversationId: 'room:r9',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
  });

  it('échappe les caractères spéciaux de LIKE', () => {
    expect(echapperMotif('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('valide la requête : texte de 2 à 100 caractères, espaces retirés, limite 1..50', async () => {
    const erreurs = async (requete: object) =>
      (await validate(plainToInstance(RechercheQueryDto, requete))).map(
        (e) => e.property,
      );
    expect(await erreurs({ q: '  ok  ' })).toEqual([]);
    expect(plainToInstance(RechercheQueryDto, { q: ' ok ' })).toMatchObject({
      q: 'ok',
      limit: 20,
    });
    expect(await erreurs({ q: ' a ' })).toEqual(['q']);
    expect(await erreurs({ q: 'x'.repeat(101) })).toEqual(['q']);
    expect(await erreurs({ q: 42 })).toEqual(['q']);
    expect(await erreurs({})).toEqual(['q']);
    expect(await erreurs({ q: 'ok', limit: '0' })).toEqual(['limit']);
    expect(await erreurs({ q: 'ok', limit: '51' })).toEqual(['limit']);
    expect(await erreurs({ q: 'ok', conversationId: 'room:r1' })).toEqual([]);
    expect(await erreurs({ q: 'ok', conversationId: 'dm:u1' })).toEqual([]);
    for (const invalide of ['salon:r1', 'room:', 'dm:a:b', 'room']) {
      expect(await erreurs({ q: 'ok', conversationId: invalide })).toEqual([
        'conversationId',
      ]);
    }
    expect(await erreurs({ q: 'ok', cursor: 'x'.repeat(201) })).toEqual([
      'cursor',
    ]);
  });
});
