import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResumeRechercheQueryDto } from './dto/resume-recherche-query.dto';
import { MESSAGE_BIENVENUE_ID, RechercheService } from './recherche.service';

describe('résumé de recherche', () => {
  const acteur = { id: 'moi', role: 'utilisateur' as const };
  const prisma = {
    privateMessage: { groupBy: jest.fn() },
    roomMessage: {
      groupBy: jest.fn(),
      fields: { createdAt: 'champ createdAt' },
    },
  };
  const rooms = { salonsLisibles: jest.fn() };
  const service = new RechercheService(prisma as never, rooms as never);
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.privateMessage.groupBy.mockResolvedValue([]);
    prisma.roomMessage.groupBy.mockResolvedValue([]);
    rooms.salonsLisibles.mockResolvedValue([
      { salonId: 'a', serveurId: 's1' },
      { salonId: 'b', serveurId: 's1' },
      { salonId: 'c', serveurId: 's2' },
      { salonId: 'd', serveurId: 's2' },
    ]);
  });
  it('additionne les deux sens des DM et les salons, sans limiter aux premières correspondances', async () => {
    prisma.privateMessage.groupBy.mockResolvedValue([
      { senderId: 'moi', recipientId: 'alice', _count: { _all: 60 } },
      { senderId: 'alice', recipientId: 'moi', _count: { _all: 5 } },
      { senderId: 'bob', recipientId: 'moi', _count: { _all: 8 } },
      { senderId: 'charlie', recipientId: 'moi', _count: { _all: 8 } },
    ]);
    prisma.roomMessage.groupBy.mockResolvedValue([
      { roomId: 'b', _count: { _all: 4 } },
      { roomId: 'a', _count: { _all: 4 } },
      { roomId: 'c', _count: { _all: 6 } },
      { roomId: 'd', _count: { _all: 2 } },
    ]);
    expect(await service.resumer(acteur, '50%_\\')).toEqual({
      directMessages: [
        { conversationId: 'dm:alice', count: 65 },
        { conversationId: 'dm:bob', count: 8 },
        { conversationId: 'dm:charlie', count: 8 },
      ],
      servers: [
        {
          serverId: 's1',
          count: 8,
          channels: [
            { conversationId: 'room:a', count: 4 },
            { conversationId: 'room:b', count: 4 },
          ],
        },
        {
          serverId: 's2',
          count: 8,
          channels: [
            { conversationId: 'room:c', count: 6 },
            { conversationId: 'room:d', count: 2 },
          ],
        },
      ],
    });
    expect(rooms.salonsLisibles).toHaveBeenCalledWith(acteur);
    const content = { contains: '50\\%\\_\\\\', mode: 'insensitive' };
    expect(prisma.privateMessage.groupBy).toHaveBeenCalledWith({
      by: ['senderId', 'recipientId'],
      where: { OR: [{ senderId: 'moi' }, { recipientId: 'moi' }], content },
      _count: { _all: true },
    });
    expect(prisma.roomMessage.groupBy).toHaveBeenCalledWith({
      by: ['roomId'],
      where: {
        roomId: { in: ['a', 'b', 'c', 'd'] },
        content,
        NOT: {
          id: MESSAGE_BIENVENUE_ID,
          updatedAt: { equals: 'champ createdAt' },
        },
      },
      _count: { _all: true },
    });
  });
  it('classe les serveurs selon leurs totaux', async () => {
    prisma.roomMessage.groupBy.mockResolvedValue([
      { roomId: 'a', _count: { _all: 1 } },
      { roomId: 'c', _count: { _all: 2 } },
    ]);
    expect(
      (await service.resumer(acteur, 'bonjour')).servers.map((s) => s.serverId),
    ).toEqual(['s2', 's1']);
  });
  it('ne consulte pas les salons sans accès et omet les groupes vides', async () => {
    rooms.salonsLisibles.mockResolvedValue([]);
    expect(await service.resumer(acteur, 'bonjour')).toEqual({
      directMessages: [],
      servers: [],
    });
    expect(prisma.roomMessage.groupBy).not.toHaveBeenCalled();
  });
  it('propage une panne de droits au lieu de publier un résumé partiel', async () => {
    rooms.salonsLisibles.mockRejectedValue(new Error('indisponible'));
    await expect(service.resumer(acteur, 'bonjour')).rejects.toThrow(
      'indisponible',
    );
    expect(prisma.privateMessage.groupBy).not.toHaveBeenCalled();
  });
  it.each(['a', 'x'.repeat(101), 12])(
    'valide le texte %s avant agrégation',
    async (q) => {
      expect(
        await validate(plainToInstance(ResumeRechercheQueryDto, { q })),
      ).not.toHaveLength(0);
    },
  );
  it('conserve la normalisation et les contraintes de la recherche', async () => {
    const dto = plainToInstance(ResumeRechercheQueryDto, { q: ' bonjour ' });
    expect(dto.q).toBe('bonjour');
    expect(await validate(dto)).toHaveLength(0);
  });
});
