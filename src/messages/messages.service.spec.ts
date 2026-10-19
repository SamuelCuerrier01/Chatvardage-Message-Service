jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    status: 'ready',
    publish: jest.fn().mockRejectedValue(new Error('redis down')),
  })),
}));

import {
  HttpException,
  HttpStatus,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RedisService } from '../redis.service';

import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  const msg = {
    id: 'm1',
    senderId: 'u1',
    recipientId: 'u2',
    content: 'hi',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let prisma: any;
  let redis: any;
  let limiteEnvoi: any;
  let destinataires: any;
  let lecture: any;
  let service: MessagesService;
  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
      privateMessage: {
        create: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    redis = { publierApresEcriture: jest.fn() };
    limiteEnvoi = { verifier: jest.fn() };
    destinataires = { exigerExistant: jest.fn().mockResolvedValue(undefined) };
    lecture = { compteursDm: jest.fn().mockResolvedValue(new Map()) };
    service = new MessagesService(
      prisma,
      redis,
      limiteEnvoi,
      destinataires,
      lecture,
    );
  });
  it('seul le destinataire confirme la livraison sans modifier le texte', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue({
      ...msg,
      deliveredAt: null,
    });
    const delivered = { ...msg, deliveredAt: new Date() };
    prisma.$queryRaw.mockResolvedValue([delivered]);
    await expect(service.markDelivered('u2', 'm1')).resolves.toEqual(delivered);
    expect(prisma.privateMessage.update).not.toHaveBeenCalled();
    expect(redis.publierApresEcriture).toHaveBeenCalledWith(
      'private-message.delivered',
      delivered,
    );
  });
  it('refuse une confirmation par lexpediteur ou un tiers', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue({
      ...msg,
      deliveredAt: null,
    });
    await expect(service.markDelivered('u1', 'm1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.privateMessage.update).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('une confirmation repetee reste idempotente', async () => {
    const delivered = { ...msg, deliveredAt: new Date() };
    prisma.privateMessage.findUnique.mockResolvedValue(delivered);
    await expect(service.markDelivered('u2', 'm1')).resolves.toBe(delivered);
    expect(prisma.privateMessage.update).not.toHaveBeenCalled();
    expect(redis.publierApresEcriture).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('refuse un message inconnu', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(null);
    await expect(service.markDelivered('u2', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('propage une panne de stockage', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue({
      ...msg,
      deliveredAt: null,
    });
    prisma.$queryRaw.mockRejectedValueOnce(new Error('database'));
    await expect(service.markDelivered('u2', 'm1')).rejects.toThrow('database');
  });
  it('deux confirmations concurrentes ne publient qu une livraison', async () => {
    const delivered = { ...msg, deliveredAt: new Date() };
    prisma.privateMessage.findUnique
      .mockResolvedValueOnce({ ...msg, deliveredAt: null })
      .mockResolvedValueOnce({ ...msg, deliveredAt: null })
      .mockResolvedValue(delivered);
    prisma.$queryRaw
      .mockResolvedValueOnce([delivered])
      .mockResolvedValueOnce([]);
    const resultats = await Promise.all([
      service.markDelivered('u2', 'm1'),
      service.markDelivered('u2', 'm1'),
    ]);
    expect(resultats).toEqual([delivered, delivered]);
    expect(redis.publierApresEcriture).toHaveBeenCalledTimes(1);
  });
  it('refuse un message supprimé pendant la confirmation', async () => {
    prisma.privateMessage.findUnique
      .mockResolvedValueOnce({ ...msg, deliveredAt: null })
      .mockResolvedValueOnce(null);
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.markDelivered('u2', 'm1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(redis.publierApresEcriture).not.toHaveBeenCalled();
  });
  it('creates then publishes', async () => {
    prisma.privateMessage.create.mockResolvedValue(msg);
    redis.publierApresEcriture.mockResolvedValue(1);
    await expect(
      service.create('u1', { recipientId: 'u2', content: 'hi' }, 'jwt'),
    ).resolves.toBe(msg);
    expect(redis.publierApresEcriture).toHaveBeenCalledWith(
      'private-message.created',
      msg,
    );
    expect(limiteEnvoi.verifier).toHaveBeenCalledWith('u1');
    expect(destinataires.exigerExistant).toHaveBeenCalledWith('u2', 'jwt');
  });
  it('checks the impersonated sender before creating an admin message', async () => {
    prisma.privateMessage.create.mockResolvedValue(msg);
    await expect(
      service.createForAdmin(
        { senderId: 'u1', recipientId: 'u2', content: 'hi' },
        'jwt-admin',
        'admin',
      ),
    ).resolves.toBe(msg);
    expect(destinataires.exigerExistant.mock.calls).toEqual([
      ['u1', 'jwt-admin'],
      ['u2', 'jwt-admin'],
    ]);
  });
  it('rejects an unknown impersonated sender before writing', async () => {
    destinataires.exigerExistant.mockRejectedValue(
      new NotFoundException('Destinataire introuvable'),
    );
    await expect(
      service.createForAdmin(
        { senderId: 'u9', recipientId: 'u2', content: 'hi' },
        'jwt-admin',
        'admin',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.privateMessage.create).not.toHaveBeenCalled();
  });
  it('audits an admin message before publishing it', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    prisma.privateMessage.create.mockResolvedValue(msg);
    redis.publierApresEcriture.mockResolvedValue(undefined);
    try {
      await expect(
        service.createForAdmin(
          { senderId: 'u1', recipientId: 'u2', content: 'hi' },
          'jwt-admin',
          'admin',
        ),
      ).resolves.toBe(msg);
      expect(log).toHaveBeenCalledWith(
        'Admin admin a créé le DM m1 au nom de u1',
      );
      expect(redis.publierApresEcriture).toHaveBeenCalledWith(
        'private-message.created',
        msg,
      );
      expect(log.mock.invocationCallOrder[0]).toBeLessThan(
        redis.publierApresEcriture.mock.invocationCallOrder[0],
      );
    } finally {
      log.mockRestore();
    }
  });
  it('rejects a private message to a recipient that does not exist', async () => {
    destinataires.exigerExistant.mockRejectedValue(
      new NotFoundException('Destinataire introuvable'),
    );
    await expect(
      service.create('u1', { recipientId: 'u9', content: 'hi' }, 'jwt'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.privateMessage.create).not.toHaveBeenCalled();
  });
  it('rejects a private message over the send limit', async () => {
    limiteEnvoi.verifier.mockImplementation(() => {
      throw new HttpException('trop', HttpStatus.TOO_MANY_REQUESTS);
    });
    await expect(
      service.create('u1', { recipientId: 'u2', content: 'hi' }, 'jwt'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.privateMessage.create).not.toHaveBeenCalled();
  });
  it('rejects a private message sent to self', async () => {
    await expect(
      service.create('u1', { recipientId: 'u1', content: 'hi' }, 'jwt'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.privateMessage.create).not.toHaveBeenCalled();
    expect(redis.publierApresEcriture).not.toHaveBeenCalled();
  });
  it('does not publish when create fails', async () => {
    prisma.privateMessage.create.mockRejectedValue(new Error('db'));
    await expect(
      service.create('u1', { recipientId: 'u2', content: 'x' }, 'jwt'),
    ).rejects.toThrow('db');
    expect(redis.publierApresEcriture).not.toHaveBeenCalled();
  });
  it('returns history', async () => {
    prisma.privateMessage.findMany.mockResolvedValue([msg]);
    await expect(service.history('u1', 'u2', { limit: 50 })).resolves.toEqual([
      msg,
    ]);
    expect(prisma.privateMessage.findMany).toHaveBeenCalled();
  });
  it('returns paginated history with cursor', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue({ id: 'm0' });
    prisma.privateMessage.findMany.mockResolvedValue([msg]);
    await expect(
      service.history('u1', 'u2', { cursor: 'm0', limit: 10 }),
    ).resolves.toEqual([msg]);
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'm0' }, skip: 1, take: 10 }),
    );
  });
  it('rejects a cursor outside the conversation', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue(null);

    await expect(
      service.history('u1', 'u2', { cursor: 'other-message', limit: 10 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
  });
  it('returns an empty conversation list without loading any message', async () => {
    await expect(service.listConversations('u1')).resolves.toEqual([]);
    expect(prisma.privateMessage.groupBy).toHaveBeenCalledWith({
      by: ['recipientId'],
      where: { senderId: 'u1' },
      _max: { createdAt: true },
    });
    expect(prisma.privateMessage.groupBy).toHaveBeenCalledWith({
      by: ['senderId'],
      where: { recipientId: 'u1' },
      _max: { createdAt: true },
    });
    expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
  });

  it('only fetches the last message exchanged with each counterpart', async () => {
    const jan1 = new Date('2026-01-01');
    const jan2 = new Date('2026-01-02');
    const jan3 = new Date('2026-01-03');
    prisma.privateMessage.groupBy
      .mockResolvedValueOnce([
        { recipientId: 'u2', _max: { createdAt: jan1 } },
        { recipientId: 'u3', _max: { createdAt: jan2 } },
      ])
      .mockResolvedValueOnce([
        { senderId: 'u2', _max: { createdAt: jan3 } },
        { senderId: 'u3', _max: { createdAt: jan1 } },
        { senderId: 'u4', _max: { createdAt: null } },
      ]);
    prisma.privateMessage.findMany.mockResolvedValue([]);

    await service.listConversations('u1');

    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            createdAt: jan3,
            OR: [
              { senderId: 'u1', recipientId: 'u2' },
              { senderId: 'u2', recipientId: 'u1' },
            ],
          },
          {
            createdAt: jan2,
            OR: [
              { senderId: 'u1', recipientId: 'u3' },
              { senderId: 'u3', recipientId: 'u1' },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('lists one conversation per counterpart, most recent activity first', async () => {
    const date = new Date('2026-01-03');
    const withU2 = {
      id: 'm3',
      senderId: 'u2',
      recipientId: 'u1',
      content: 'yo',
      createdAt: date,
      updatedAt: date,
    };
    const sameMsWithU2 = { ...withU2, id: 'm2', content: 'doublon' };
    const withU3 = {
      id: 'm1',
      senderId: 'u1',
      recipientId: 'u3',
      content: 'hey',
      createdAt: new Date('2026-01-02'),
      updatedAt: new Date('2026-01-02'),
    };
    prisma.privateMessage.groupBy
      .mockResolvedValueOnce([
        { recipientId: 'u3', _max: { createdAt: withU3.createdAt } },
      ])
      .mockResolvedValueOnce([{ senderId: 'u2', _max: { createdAt: date } }]);
    prisma.privateMessage.findMany.mockResolvedValue([
      withU2,
      sameMsWithU2,
      withU3,
    ]);

    lecture.compteursDm.mockResolvedValue(new Map([['u2', 4]]));

    await expect(service.listConversations('u1')).resolves.toEqual([
      { otherUserId: 'u2', lastMessage: withU2, unreadCount: 4 },
      { otherUserId: 'u3', lastMessage: withU3, unreadCount: 0 },
    ]);
    expect(lecture.compteursDm).toHaveBeenCalledWith('u1');
  });

  it('findOne not found', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(null);
    await expect(service.findOne('u1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('findOne forbidden', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    await expect(service.findOne('u3', 'm1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('findOne sender', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    await expect(service.findOne('u1', 'm1')).resolves.toBe(msg);
  });
  it('findOne recipient', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    await expect(service.findOne('u2', 'm1')).resolves.toBe(msg);
  });
  it('lists messages and deletes a message for an administrator', async () => {
    prisma.privateMessage.findMany.mockResolvedValue([msg]);
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    prisma.privateMessage.delete.mockResolvedValue(msg);

    await expect(service.findAllForAdmin({ limit: 50 })).resolves.toEqual([
      msg,
    ]);
    await expect(
      service.removeForAdmin('m1', 'admin'),
    ).resolves.toBeUndefined();
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    expect(redis.publierApresEcriture).toHaveBeenCalledWith(
      'private-message.deleted',
      {
        id: 'm1',
        senderId: 'u1',
        recipientId: 'u2',
      },
    );
  });
  it('paginates admin messages filtered by participant', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.privateMessage.findMany.mockResolvedValue([msg]);
    await expect(
      service.findAllForAdmin({ cursor: 'm1', limit: 10, userId: 'u1' }),
    ).resolves.toEqual([msg]);
    const where = { OR: [{ senderId: 'u1' }, { recipientId: 'u1' }] };
    expect(prisma.privateMessage.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1', ...where },
      select: { id: true },
    });
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith({
      where,
      cursor: { id: 'm1' },
      skip: 1,
      take: 10,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
  it('rejects an admin cursor outside the selected participant', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue(null);
    await expect(
      service.findAllForAdmin({ cursor: 'm1', limit: 10, userId: 'u3' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
  });
  it('refuses to delete an unknown message for an administrator', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(null);

    await expect(
      service.removeForAdmin('inconnu', 'admin'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.privateMessage.delete).not.toHaveBeenCalled();
  });
  it('update not found', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(null);
    await expect(
      service.update('u1', 'x', { content: 'n' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('update forbidden', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    await expect(
      service.update('u2', 'm1', { content: 'n' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('updates then publishes', async () => {
    const updated = { ...msg, content: 'n' };
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    prisma.privateMessage.update.mockResolvedValue(updated);
    redis.publierApresEcriture.mockResolvedValue(1);
    await expect(service.update('u1', 'm1', { content: 'n' })).resolves.toBe(
      updated,
    );
    expect(redis.publierApresEcriture).toHaveBeenCalledWith(
      'private-message.updated',
      updated,
    );
  });
  describe('Redis indisponible après l écriture', () => {
    let error: jest.SpyInstance;

    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      service = new MessagesService(
        prisma,
        new RedisService(),
        limiteEnvoi,
        destinataires,
        lecture,
      );
    });

    afterEach(() => error.mockRestore());

    it('confirme la création, la modification, la livraison et les suppressions enregistrées', async () => {
      const updated = { ...msg, content: 'n' };
      const delivered = { ...msg, deliveredAt: new Date() };
      prisma.privateMessage.create.mockResolvedValue(msg);
      prisma.privateMessage.findUnique
        .mockResolvedValueOnce(msg)
        .mockResolvedValueOnce({ ...msg, deliveredAt: null })
        .mockResolvedValue(msg);
      prisma.privateMessage.update.mockResolvedValue(updated);
      prisma.$queryRaw.mockResolvedValue([delivered]);

      await expect(
        service.create('u1', { recipientId: 'u2', content: 'hi' }, 'jwt'),
      ).resolves.toBe(msg);
      await expect(service.update('u1', 'm1', { content: 'n' })).resolves.toBe(
        updated,
      );
      await expect(service.markDelivered('u2', 'm1')).resolves.toBe(delivered);
      await expect(service.remove('u1', 'm1')).resolves.toBeUndefined();
      await expect(
        service.removeForAdmin('m1', 'admin'),
      ).resolves.toBeUndefined();
      expect(error.mock.calls.map(([texte]) => texte.split(' ')[1])).toEqual([
        'private-message.created',
        'private-message.updated',
        'private-message.delivered',
        'private-message.deleted',
        'private-message.deleted',
      ]);
    });
  });
  it('remove not found', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(null);
    await expect(service.remove('u1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('remove forbidden', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    await expect(service.remove('u2', 'm1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('deletes then publishes routed event', async () => {
    prisma.privateMessage.findUnique.mockResolvedValue(msg);
    prisma.privateMessage.delete.mockResolvedValue(msg);
    redis.publierApresEcriture.mockResolvedValue(1);
    await service.remove('u1', 'm1');
    expect(redis.publierApresEcriture).toHaveBeenCalledWith(
      'private-message.deleted',
      {
        id: 'm1',
        senderId: 'u1',
        recipientId: 'u2',
      },
    );
  });

  it('deletes both directions of a deleted user’s conversations', async () => {
    await expect(service.supprimerUtilisateur('u1')).resolves.toBe(4);
    expect(prisma.privateMessage.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ senderId: 'u1' }, { recipientId: 'u1' }] },
    });
  });

  it('ouvre une page au message cible inclus avec un seul acces pagine', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.privateMessage.findMany.mockResolvedValue([msg]);
    const query = { around: 'm1', limit: 50 };
    expect(await service.history('u1', 'u2', query)).toEqual([msg]);
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'm1' }, skip: 0, take: 50 }),
    );
  });
  it('pagine vers les messages plus recents dans un ordre stable', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.privateMessage.findMany.mockResolvedValue([
      msg,
      { ...msg, id: 'm2' },
    ]);
    const query = { cursor: 'm1', direction: 'after' as const, limit: 50 };
    expect((await service.history('u1', 'u2', query)).map((m) => m.id)).toEqual(
      ['m1', 'm2'],
    );
    expect(prisma.privateMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 1,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });
  it.each([
    { around: 'm1', cursor: 'm2', limit: 50 },
    { direction: 'after' as const, limit: 50 },
    { around: 'm1', direction: 'after' as const, limit: 50 },
    { around: 'm1', cursor: 'm2', direction: 'after' as const, limit: 50 },
  ])(
    'refuse une pagination incompatible sans lire les messages',
    async (query) => {
      await expect(service.history('u1', 'u2', query)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
    },
  );
  it('refuse une cible absente ou appartenant a une autre conversation', async () => {
    prisma.privateMessage.findFirst.mockResolvedValue(null);
    const query = { around: 'foreign', limit: 50 };
    await expect(service.history('u1', 'u2', query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.privateMessage.findMany).not.toHaveBeenCalled();
  });
});
