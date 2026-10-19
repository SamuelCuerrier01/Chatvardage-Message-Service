import {
  HttpException,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoomMessagesService } from './room-messages.service';

describe('RoomMessagesService', () => {
  const msg = {
    id: 'm1',
    roomId: 'r1',
    authorId: 'u1',
    content: 'hi',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const lecteurEcrivain = {
    salonId: 'r1',
    serveurId: 's1',
    estMembre: true,
    peutLire: true,
    peutEcrire: true,
    peutModerer: false,
  };
  const lectureSeule = { ...lecteurEcrivain, peutEcrire: false };
  const sansAcces = {
    ...lecteurEcrivain,
    estMembre: false,
    peutLire: false,
    peutEcrire: false,
  };
  const acteur = (id: string) => ({ id, role: 'utilisateur' as const });
  let prisma: any;
  let redis: any;
  let rooms: any;
  let limiteEnvoi: any;
  let destinataires: any;
  let service: RoomMessagesService;

  beforeEach(() => {
    prisma = {
      roomMessage: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    };
    redis = { publish: jest.fn() };
    rooms = { verifierAcces: jest.fn().mockResolvedValue(lecteurEcrivain) };
    limiteEnvoi = { verifier: jest.fn() };
    destinataires = { roleDe: jest.fn().mockResolvedValue('utilisateur') };
    service = new RoomMessagesService(
      prisma,
      redis,
      rooms,
      limiteEnvoi,
      destinataires,
    );
  });

  it('creates then publishes', async () => {
    prisma.roomMessage.create.mockResolvedValue(msg);
    redis.publish.mockResolvedValue(1);

    await expect(
      service.create(acteur('u1'), 'r1', { content: 'hi' }),
    ).resolves.toBe(msg);
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', acteur('u1'));
    expect(prisma.roomMessage.create).toHaveBeenCalledWith({
      data: { roomId: 'r1', authorId: 'u1', content: 'hi' },
    });
    expect(redis.publish).toHaveBeenCalledWith('room-message.created', msg);
    expect(limiteEnvoi.verifier).toHaveBeenCalledWith('u1');
  });

  it('creates an admin message with the selected author then publishes', async () => {
    prisma.roomMessage.create.mockResolvedValue(msg);
    redis.publish.mockResolvedValue(1);

    await expect(
      service.createForAdmin(
        acteur('admin'),
        'r1',
        {
          authorId: 'u1',
          content: 'hi',
        },
        'jwt-admin',
      ),
    ).resolves.toBe(msg);
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', acteur('admin'));
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', acteur('u1'));
    expect(destinataires.roleDe).toHaveBeenCalledWith('u1', 'jwt-admin');
    expect(prisma.roomMessage.create).toHaveBeenCalledWith({
      data: { roomId: 'r1', authorId: 'u1', content: 'hi' },
    });
    expect(redis.publish).toHaveBeenCalledWith('room-message.created', msg);
    expect(limiteEnvoi.verifier).toHaveBeenCalledWith('u1');
  });

  it('rejects an admin message in a read-only room', async () => {
    rooms.verifierAcces.mockResolvedValue(lectureSeule);

    await expect(
      service.createForAdmin(
        acteur('admin'),
        'r1',
        {
          authorId: 'u1',
          content: 'hi',
        },
        'jwt-admin',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(limiteEnvoi.verifier).not.toHaveBeenCalled();
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
  });

  it("evaluates the author's room access with their real global role", async () => {
    destinataires.roleDe.mockResolvedValue('admin');
    prisma.roomMessage.create.mockResolvedValue(msg);
    await service.createForAdmin(
      acteur('admin'),
      'r1',
      { authorId: 'u1', content: 'hi' },
      'jwt-admin',
    );
    expect(rooms.verifierAcces).toHaveBeenLastCalledWith('r1', {
      id: 'u1',
      role: 'admin',
    });
  });

  it('rejects an unknown admin-selected author without using its send limit', async () => {
    destinataires.roleDe.mockRejectedValue(new NotFoundException());
    await expect(
      service.createForAdmin(
        acteur('admin'),
        'r1',
        { authorId: 'missing', content: 'hi' },
        'jwt',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(limiteEnvoi.verifier).not.toHaveBeenCalled();
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
  });

  it.each([sansAcces, lectureSeule])(
    'rejects an admin-selected author without room write access',
    async (accesAuteur) => {
      rooms.verifierAcces
        .mockResolvedValueOnce(lecteurEcrivain)
        .mockResolvedValueOnce(accesAuteur);
      await expect(
        service.createForAdmin(
          acteur('admin'),
          'r1',
          { authorId: 'u1', content: 'hi' },
          'jwt',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(limiteEnvoi.verifier).not.toHaveBeenCalled();
      expect(prisma.roomMessage.create).not.toHaveBeenCalled();
    },
  );

  it('rejects create over the send limit without calling Room-Service', async () => {
    limiteEnvoi.verifier.mockImplementation(() => {
      throw new HttpException('trop', HttpStatus.TOO_MANY_REQUESTS);
    });

    await expect(
      service.create(acteur('u1'), 'r1', { content: 'hi' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(rooms.verifierAcces).not.toHaveBeenCalled();
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
  });

  it('rejects create when the caller is not a room member', async () => {
    rooms.verifierAcces.mockResolvedValue(sansAcces);

    await expect(
      service.create(acteur('stranger'), 'r1', { content: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('propagates room lookup failures on create', async () => {
    rooms.verifierAcces.mockRejectedValue(
      new NotFoundException('Salon introuvable'),
    );

    await expect(
      service.create(acteur('u1'), 'missing', { content: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
  });

  it('does not publish when create fails', async () => {
    prisma.roomMessage.create.mockRejectedValue(new Error('db'));

    await expect(
      service.create(acteur('u1'), 'r1', { content: 'x' }),
    ).rejects.toThrow('db');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('returns history for a member', async () => {
    prisma.roomMessage.findMany.mockResolvedValue([msg]);

    await expect(
      service.history(acteur('u1'), 'r1', { limit: 50 }),
    ).resolves.toEqual([msg]);
    expect(prisma.roomMessage.findMany).toHaveBeenCalled();
  });

  it('rejects history when the caller is not a room member', async () => {
    rooms.verifierAcces.mockResolvedValue(sansAcces);

    await expect(
      service.history(acteur('stranger'), 'r1', { limit: 50 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
  });

  it('returns paginated history with cursor', async () => {
    prisma.roomMessage.findFirst.mockResolvedValue({ id: 'm0' });
    prisma.roomMessage.findMany.mockResolvedValue([msg]);

    await expect(
      service.history(acteur('u1'), 'r1', { cursor: 'm0', limit: 10 }),
    ).resolves.toEqual([msg]);
    expect(prisma.roomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'm0' }, skip: 1, take: 10 }),
    );
  });

  it('rejects a cursor outside the room', async () => {
    prisma.roomMessage.findFirst.mockResolvedValue(null);

    await expect(
      service.history(acteur('u1'), 'r1', {
        cursor: 'other-message',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
  });

  it('findOne not found', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(null);

    await expect(
      service.findOne(acteur('u1'), 'r1', 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findOne not found when message belongs to a different room', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue({ ...msg, roomId: 'r2' });

    await expect(
      service.findOne(acteur('u1'), 'r1', 'm1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findOne forbidden for a non-member', async () => {
    rooms.verifierAcces.mockResolvedValue(sansAcces);

    await expect(
      service.findOne(acteur('stranger'), 'r1', 'm1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.roomMessage.findUnique).not.toHaveBeenCalled();
  });

  it('findOne returns the message for any room member', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(msg);

    await expect(service.findOne(acteur('u2'), 'r1', 'm1')).resolves.toBe(msg);
  });

  it('update not found', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(null);
    await expect(
      service.update(acteur('u1'), 'r1', 'x', { content: 'n' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update not found when message belongs to a different room', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue({ ...msg, roomId: 'r2' });
    await expect(
      service.update(acteur('u1'), 'r1', 'm1', { content: 'n' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update forbidden for a non-author', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    await expect(
      service.update(acteur('u2'), 'r1', 'm1', { content: 'n' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates then publishes', async () => {
    const updated = { ...msg, content: 'n' };
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    prisma.roomMessage.update.mockResolvedValue(updated);
    redis.publish.mockResolvedValue(1);

    await expect(
      service.update(acteur('u1'), 'r1', 'm1', { content: 'n' }),
    ).resolves.toBe(updated);
    expect(redis.publish).toHaveBeenCalledWith('room-message.updated', updated);
  });

  it('remove not found', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(null);
    await expect(
      service.remove(acteur('u1'), 'r1', 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove not found when message belongs to a different room', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue({ ...msg, roomId: 'r2' });
    await expect(
      service.remove(acteur('u1'), 'r1', 'm1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove forbidden for a non-author', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    await expect(
      service.remove(acteur('u2'), 'r1', 'm1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a moderator can remove another member’s message', async () => {
    rooms.verifierAcces.mockResolvedValue({
      ...lecteurEcrivain,
      peutModerer: true,
    });
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    prisma.roomMessage.delete.mockResolvedValue(msg);
    await service.remove(acteur('modo'), 'r1', 'm1');
    expect(prisma.roomMessage.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
    expect(redis.publish).toHaveBeenCalledWith(
      'room-message.deleted',
      expect.objectContaining({ id: 'm1' }),
    );
  });

  it('a moderator still cannot edit another member’s message', async () => {
    rooms.verifierAcces.mockResolvedValue({
      ...lecteurEcrivain,
      peutModerer: true,
    });
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    await expect(
      service.update(acteur('modo'), 'r1', 'm1', { content: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('purges the messages of deleted rooms, and those of a deleted author', async () => {
    await expect(service.purgerSalons(['r1', 'r2'])).resolves.toBe(3);
    expect(prisma.roomMessage.deleteMany).toHaveBeenCalledWith({
      where: { roomId: { in: ['r1', 'r2'] } },
    });
    await expect(service.supprimerAuteur('u1')).resolves.toBe(3);
    expect(prisma.roomMessage.deleteMany).toHaveBeenLastCalledWith({
      where: { authorId: 'u1' },
    });
  });

  it('deletes then publishes routed event', async () => {
    prisma.roomMessage.findUnique.mockResolvedValue(msg);
    prisma.roomMessage.delete.mockResolvedValue(msg);
    redis.publish.mockResolvedValue(1);

    await service.remove(acteur('u1'), 'r1', 'm1');
    expect(redis.publish).toHaveBeenCalledWith('room-message.deleted', {
      id: 'm1',
      roomId: 'r1',
      authorId: 'u1',
    });
  });

  it('rejects create in a read-only room (#annonces) for a member', async () => {
    rooms.verifierAcces.mockResolvedValue(lectureSeule);

    await expect(
      service.create(acteur('u1'), 'r1', { content: 'hi' }),
    ).rejects.toThrow('Seuls les modérateurs peuvent écrire dans ce salon');
    expect(prisma.roomMessage.create).not.toHaveBeenCalled();
  });

  it.each(['update', 'remove'] as const)(
    'rejects %s when the caller lost access to the room',
    async (methode) => {
      rooms.verifierAcces.mockResolvedValue(sansAcces);
      const appel =
        methode === 'update'
          ? service.update(acteur('u1'), 'r1', 'm1', { content: 'n' })
          : service.remove(acteur('u1'), 'r1', 'm1');

      await expect(appel).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.roomMessage.findUnique).not.toHaveBeenCalled();
    },
  );

  it('ouvre une page au message cible inclus avec un seul acces pagine', async () => {
    prisma.roomMessage.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.roomMessage.findMany.mockResolvedValue([msg]);
    const query = { around: 'm1', limit: 50 };
    expect(await service.history(acteur('u1'), 'r1', query)).toEqual([msg]);
    expect(prisma.roomMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'm1' }, skip: 0, take: 50 }),
    );
  });
  it('pagine vers les messages plus recents dans un ordre stable', async () => {
    prisma.roomMessage.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.roomMessage.findMany.mockResolvedValue([msg, { ...msg, id: 'm2' }]);
    const query = { cursor: 'm1', direction: 'after' as const, limit: 50 };
    expect(
      (await service.history(acteur('u1'), 'r1', query)).map((m) => m.id),
    ).toEqual(['m1', 'm2']);
    expect(prisma.roomMessage.findMany).toHaveBeenCalledWith(
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
      await expect(
        service.history(acteur('u1'), 'r1', query),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
    },
  );
  it('refuse une cible absente ou appartenant a une autre conversation', async () => {
    prisma.roomMessage.findFirst.mockResolvedValue(null);
    const query = { around: 'foreign', limit: 50 };
    await expect(
      service.history(acteur('u1'), 'r1', query),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.roomMessage.findMany).not.toHaveBeenCalled();
  });
});
