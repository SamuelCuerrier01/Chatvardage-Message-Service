import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DELAI_MIN_PRESENCE_MS,
  DELAI_MIN_PROFIL_MS,
  DELAI_MIN_SAISIE_MS,
  isAllowedOrigin,
  MessagesGateway,
  utilisateursARevalider,
  INTERVALLE_REVALIDATION_MS,
  DELAI_MIN_SUIVI_PRESENCE_MS,
} from './messages.gateway';

describe('MessagesGateway', () => {
  it('accepts the default WebSocket CORS origin', () => {
    delete process.env.CORS_ORIGINS;
    const callback = jest.fn();

    isAllowedOrigin('http://localhost:5173', callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('reads and filters configured WebSocket CORS origins at connection time', () => {
    process.env.CORS_ORIGINS = ' http://one.test, ,http://two.test ';
    const callback = jest.fn();

    isAllowedOrigin('http://two.test', callback);

    expect(callback).toHaveBeenCalledWith(null, true);
    delete process.env.CORS_ORIGINS;
  });

  it('rejects an unknown WebSocket CORS origin', () => {
    process.env.CORS_ORIGINS = 'http://allowed.test';
    const callback = jest.fn();

    isAllowedOrigin('http://blocked.test', callback);

    expect(callback).toHaveBeenCalledWith(null, false);
    delete process.env.CORS_ORIGINS;
  });

  it('accepts a WebSocket client without an Origin header', () => {
    const callback = jest.fn();

    isAllowedOrigin(undefined, callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  let messages: any;
  let redis: any;
  let jwt: any;
  let roomMessages: any;
  let rooms: any;
  let gateway: MessagesGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let socketsParUtilisateur: Record<string, any[]>;

  beforeEach(() => {
    messages = { create: jest.fn() };
    redis = { subscribe: jest.fn() };
    jwt = { verifyToken: jest.fn(), verifyTokenFresh: jest.fn() };
    roomMessages = { create: jest.fn() };
    rooms = { verifierAcces: jest.fn(), oublierServeur: jest.fn() };
    gateway = new MessagesGateway(messages, redis, jwt, roomMessages, rooms);
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    socketsParUtilisateur = {};
    const inRoom = jest.fn((room: string) => ({
      fetchSockets: jest.fn(async () =>
        Promise.resolve(socketsParUtilisateur[room.replace('user:', '')] ?? []),
      ),
    }));
    (gateway as any).server = { to, in: inRoom };
  });

  const vider = () => new Promise((resolve) => setTimeout(resolve, 0));

  function socketDansSalons(
    salons: Record<string, string> | undefined,
    role?: string,
  ) {
    return {
      data: { userId: 'u3', role, salons },
      leave: jest.fn(),
      emit: jest.fn(),
    };
  }

  it('subscribes to all DM and room channels and broadcasts DM events to both users', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );

    await gateway.afterInit();
    expect(redis.subscribe).toHaveBeenCalledWith(
      [
        'private-message.created',
        'private-message.updated',
        'private-message.deleted',
        'private-message.delivered',
        'room-message.created',
        'room-message.updated',
        'room-message.deleted',
        'presence.changed',
        'profil.changed',
        'serveur.change',
        'read-state.updated',
        'sessions.revoquees',
      ],
      expect.any(Function),
    );

    handler(
      'private-message.created',
      JSON.stringify({ id: 'm1', senderId: 'u1', recipientId: 'u2' }),
    );
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(to).toHaveBeenCalledWith('user:u2');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits once for a self-message', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler(
      'private-message.created',
      JSON.stringify({ id: 'm1', senderId: 'u1', recipientId: 'u1' }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('ignores an invalid Redis channel', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler(
      'x',
      JSON.stringify({ id: 'm1', senderId: 'u1', recipientId: 'u2' }),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores invalid JSON for a DM event', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('private-message.created', '{');
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a malformed DM Redis payload', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('private-message.created', JSON.stringify({ senderId: 'u1' }));
    expect(emit).not.toHaveBeenCalled();
  });

  it('broadcasts a room event to the room', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler(
      'room-message.created',
      JSON.stringify({ id: 'm1', roomId: 'r1', authorId: 'u1' }),
    );
    expect(to).toHaveBeenCalledWith('room:r1');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid JSON for a room event', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('room-message.created', '{');
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a malformed room Redis payload', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('room-message.created', JSON.stringify({ authorId: 'u1' }));
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a null room Redis payload', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('room-message.created', 'null');
    expect(emit).not.toHaveBeenCalled();
  });

  it('disconnects when the socket token is missing', async () => {
    const client: any = {
      handshake: { auth: {} },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('signals a revoked session when the JWT is refused at connection', async () => {
    jwt.verifyToken.mockRejectedValue(new UnauthorizedException());
    const client: any = {
      handshake: { auth: { token: 'revoque' } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.emit).toHaveBeenCalledWith('session.revoquee');
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('does not signal a revoked session when Auth is unavailable', async () => {
    jwt.verifyToken.mockRejectedValue(new ServiceUnavailableException());
    const client: any = {
      handshake: { auth: { token: 'jwt' } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.emit).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  describe('revalidation des sockets ouverts', () => {
    const socket = (userId: string | undefined, token = 'jwt') => ({
      id: `s-${userId}`,
      handshake: { auth: { token } },
      data: { userId, role: 'utilisateur' },
      emit: jest.fn(),
      disconnect: jest.fn(),
    });
    const brancher = (sockets: any[]) => {
      (gateway as any).server = {
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      };
    };

    it('déconnecte un socket dont le jeton est refusé', async () => {
      const revoque = socket('u1', 'revoque');
      const valide = socket('u2', 'valide');
      brancher([revoque, valide]);
      jwt.verifyToken.mockImplementation(async (token: string) => {
        if (token === 'revoque') throw new UnauthorizedException();
        return { id: 'u2', role: 'admin' };
      });

      await gateway.revaliderSockets();

      expect(revoque.emit).toHaveBeenCalledWith('session.revoquee');
      expect(revoque.disconnect).toHaveBeenCalledWith(true);
      expect(valide.disconnect).not.toHaveBeenCalled();
      expect(valide.data.role).toBe('admin');
    });

    it('déconnecte aussi sur un refus 403 ou un jeton absent', async () => {
      const interdit = socket('u1');
      const sansJeton = { ...socket('u2'), handshake: { auth: {} } };
      brancher([interdit, sansJeton]);
      jwt.verifyToken.mockRejectedValue(new ForbiddenException());

      await gateway.revaliderSockets();

      expect(interdit.disconnect).toHaveBeenCalledWith(true);
      expect(sansJeton.disconnect).toHaveBeenCalledWith(true);
    });

    it('garde les sockets si Auth est indisponible (un seul avertissement), ignore ceux pas encore authentifiés', async () => {
      const avertir = jest
        .spyOn((gateway as any).logger, 'warn')
        .mockImplementation(() => undefined);
      const ouvert = socket('u1');
      const autre = socket('u2');
      const enCours = socket(undefined);
      brancher([ouvert, autre, enCours]);
      jwt.verifyToken.mockRejectedValue(new ServiceUnavailableException());

      await gateway.revaliderSockets();

      expect(ouvert.disconnect).not.toHaveBeenCalled();
      expect(jwt.verifyToken).toHaveBeenCalledTimes(2);
      expect(avertir).toHaveBeenCalledTimes(1);
      expect(avertir).toHaveBeenCalledWith(
        'Authentification indisponible : 2 socket(s) gardé(s) sans revérification',
      );
    });

    it('revalide à intervalle régulier après afterInit, arrêté à la destruction', async () => {
      jest.useFakeTimers();
      try {
        redis.subscribe.mockResolvedValue(undefined);
        const revalider = jest
          .spyOn(gateway, 'revaliderSockets')
          .mockRejectedValueOnce(new Error('panne'))
          .mockResolvedValue(undefined);
        await gateway.afterInit();

        jest.advanceTimersByTime(INTERVALLE_REVALIDATION_MS);
        await Promise.resolve();
        expect(revalider).toHaveBeenCalledTimes(1);

        gateway.onModuleDestroy();
        jest.advanceTimersByTime(INTERVALLE_REVALIDATION_MS * 2);
        expect(revalider).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('ne lance pas une seconde passe tant que la première dure', async () => {
      brancher([socket('u1')]);
      let terminer!: () => void;
      jwt.verifyToken.mockReturnValue(
        new Promise((resolve) => {
          terminer = () => resolve({ id: 'u1', role: 'utilisateur' });
        }),
      );

      const premiere = gateway.revaliderSockets();
      await gateway.revaliderSockets();
      await Promise.resolve();
      terminer();
      await premiere;
      expect((gateway as any).server.fetchSockets).toHaveBeenCalledTimes(1);

      await gateway.revaliderSockets();
      expect((gateway as any).server.fetchSockets).toHaveBeenCalledTimes(2);
    });
  });

  describe('limite de presence.update par socket', () => {
    const socket = (id = 's1') => ({ id, data: { userId: 'u1' } }) as any;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      redis.publish = jest.fn().mockResolvedValue(1);
    });
    afterEach(() => jest.useRealTimers());

    it("regroupe les changements rapprochés et envoie l'état le plus récent", async () => {
      const client = socket();
      await gateway.updatePresence(client, { statut: 'en-ligne' });
      await gateway.updatePresence(client, { statut: 'hors-ligne' });
      await gateway.updatePresence(client, { statut: 'en-ligne' });
      await gateway.updatePresence(client, { statut: 'hors-ligne' });
      expect(redis.publish).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(DELAI_MIN_PRESENCE_MS);
      expect(redis.publish).toHaveBeenCalledTimes(2);
      expect(redis.publish).toHaveBeenLastCalledWith('presence.changed', {
        userId: 'u1',
        statut: 'hors-ligne',
      });
    });

    it('envoie tout de suite une fois la fenêtre écoulée', async () => {
      const client = socket();
      await gateway.updatePresence(client, { statut: 'en-ligne' });
      jest.advanceTimersByTime(DELAI_MIN_PRESENCE_MS);
      await gateway.updatePresence(client, { statut: 'hors-ligne' });
      expect(redis.publish).toHaveBeenCalledTimes(2);
    });

    it("n'envoie pas une présence différée après la déconnexion du socket", async () => {
      (gateway as any).server.in = jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([]),
      }));
      const client = socket();
      await gateway.updatePresence(client, { statut: 'hors-ligne' });
      await gateway.updatePresence(client, { statut: 'en-ligne' });
      await gateway.handleDisconnect(client);
      jest.advanceTimersByTime(DELAI_MIN_PRESENCE_MS);

      expect(redis.publish.mock.calls).toEqual([
        ['presence.changed', { userId: 'u1', statut: 'hors-ligne' }],
        ['presence.changed', { userId: 'u1', statut: 'hors-ligne' }],
      ]);
    });

    it('journalise un envoi différé en échec', async () => {
      const logger = jest
        .spyOn((gateway as any).logger, 'warn')
        .mockImplementation(() => undefined);
      const client = socket();
      await gateway.updatePresence(client, { statut: 'en-ligne' });
      redis.publish = jest.fn().mockRejectedValue(new Error('redis'));
      await gateway.updatePresence(client, { statut: 'hors-ligne' });
      jest.advanceTimersByTime(DELAI_MIN_PRESENCE_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Présence non diffusée'),
      );
    });
  });

  it('disconnects when JWT verification fails', async () => {
    jwt.verifyToken.mockRejectedValue(new UnauthorizedException());

    const client: any = {
      handshake: { auth: { token: 'bad' } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when JWT verification throws a non-Error value', async () => {
    jwt.verifyToken.mockRejectedValue('failure');
    const client: any = {
      id: 'socket-unknown-error',
      handshake: { auth: { token: 'bad' } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('verifies JWT and joins the authenticated user room', async () => {
    jwt.verifyToken.mockResolvedValue({ id: 'u1', role: 'utilisateur' });
    const client: any = {
      handshake: { auth: { token: 'jwt' } },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(jwt.verifyToken).toHaveBeenCalledWith('jwt');
    expect(client.data.userId).toBe('u1');
    expect(client.data.role).toBe('utilisateur');
    expect(client.join).toHaveBeenCalledWith('user:u1');
    expect(client.emit).toHaveBeenLastCalledWith('connexion.prete');
  });

  it('refuses sending when the socket has no authenticated user', async () => {
    const client: any = { data: {} };
    await expect(
      gateway.send(client, { recipientId: 'u2', content: 'x' }),
    ).rejects.toThrow('Utilisateur non authentifié');
    expect(messages.create).not.toHaveBeenCalled();
  });

  it('delegates sending using the authenticated socket user', async () => {
    messages.create.mockResolvedValue({ id: 'm1' });
    const client: any = {
      data: { userId: 'u1' },
      handshake: { auth: { token: 'jwt-u1' } },
    };
    await gateway.send(client, { recipientId: 'u2', content: 'x' });
    expect(messages.create).toHaveBeenCalledWith(
      'u1',
      { recipientId: 'u2', content: 'x' },
      'jwt-u1',
    );
  });

  it('ignores the disconnect of a socket that was never authenticated', async () => {
    redis.publish = jest.fn();
    await gateway.handleDisconnect({ id: 'socket-1' } as any);
    await gateway.handleDisconnect({ id: 'socket-2', data: {} } as any);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does not announce offline while the user still has another socket', async () => {
    redis.publish = jest.fn();
    const fetchSockets = jest.fn().mockResolvedValue([{ id: 'autre' }]);
    (gateway as any).server = { in: jest.fn(() => ({ fetchSockets })) };

    await gateway.handleDisconnect({ id: 's1', data: { userId: 'u1' } } as any);

    expect((gateway as any).server.in).toHaveBeenCalledWith('user:u1');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("announces offline when the user's last socket closes", async () => {
    redis.publish = jest.fn().mockResolvedValue(1);
    const fetchSockets = jest.fn().mockResolvedValue([]);
    (gateway as any).server = { in: jest.fn(() => ({ fetchSockets })) };

    await gateway.handleDisconnect({ id: 's1', data: { userId: 'u1' } } as any);

    expect(redis.publish).toHaveBeenCalledWith('presence.changed', {
      userId: 'u1',
      statut: 'hors-ligne',
    });
  });

  it.each([new Error('redis down'), 'failure'])(
    'never throws when the offline announcement fails (%p)',
    async (erreur) => {
      redis.publish = jest.fn().mockRejectedValue(erreur);
      const fetchSockets = jest.fn().mockResolvedValue([]);
      (gateway as any).server = { in: jest.fn(() => ({ fetchSockets })) };

      await expect(
        gateway.handleDisconnect({ id: 's1', data: { userId: 'u1' } } as any),
      ).resolves.toBeUndefined();
    },
  );

  it('does not send anything but the refusal to a refused client', async () => {
    jwt.verifyToken.mockRejectedValue(new UnauthorizedException());
    const client: any = {
      handshake: { auth: { token: 'bad' } },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.emit.mock.calls).toEqual([['session.revoquee']]);
  });

  describe('presence.suivre', () => {
    const socketsDe: Record<string, any[]> = {};
    const client = (data: Record<string, unknown> = {}) => ({
      data: { userId: 'u1', ...data },
      rooms: new Set([
        'socket-id',
        'user:u1',
        'presence:ancien',
        'presence:u2',
      ]),
      join: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
    });

    beforeEach(() => {
      socketsDe.u2 = [
        { data: { userId: 'u2', presence: 'hors-ligne' } },
        { data: { userId: 'u2', presence: 'en-ligne' } },
      ];
      socketsDe.u3 = [{ data: { userId: 'u3', presence: 'hors-ligne' } }];
      socketsDe.u4 = [{ data: { userId: 'u4' } }];
      (gateway as any).server = {
        in: jest.fn((room: string) => ({
          fetchSockets: jest
            .fn()
            .mockResolvedValue(socketsDe[room.replace('user:', '')] ?? []),
        })),
      };
    });

    it('rejoint les rooms des personnes suivies, quitte les autres, renvoie qui est en ligne', async () => {
      const c: any = client();
      const reponse = await gateway.suivrePresence(c, {
        ids: ['u2', 'u3', 'u4', 'u1', 'absent'],
      });

      expect(reponse).toEqual({ enLigne: ['u2'] });
      expect(c.leave).toHaveBeenCalledWith('presence:ancien');
      expect(c.leave).toHaveBeenCalledTimes(1);
      expect(c.join).toHaveBeenCalledWith([
        'presence:u2',
        'presence:u3',
        'presence:u4',
        'presence:absent',
      ]);
    });

    it('au plus une demande par fenêtre, et seulement une fois authentifié', async () => {
      const maintenant = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      try {
        const c: any = client();
        await gateway.suivrePresence(c, { ids: [] });
        await expect(gateway.suivrePresence(c, { ids: [] })).rejects.toThrow(
          'Trop de demandes de présence',
        );
        maintenant.mockReturnValue(10_000 + DELAI_MIN_SUIVI_PRESENCE_MS);
        await expect(gateway.suivrePresence(c, { ids: [] })).resolves.toEqual({
          enLigne: [],
        });
      } finally {
        maintenant.mockRestore();
      }
      await expect(
        gateway.suivrePresence({ data: {} } as any, { ids: [] }),
      ).rejects.toThrow('Utilisateur non authentifié');
    });
  });

  it("publishes a profile change for the socket's own user only", async () => {
    redis.publish = jest.fn().mockResolvedValue(1);
    await expect(gateway.updateProfil({ data: {} } as any)).rejects.toThrow(
      'Utilisateur non authentifié',
    );
    await expect(
      gateway.updateProfil({ id: 's1', data: { userId: 'u1' } } as any),
    ).resolves.toEqual({ ok: true });
    expect(redis.publish).toHaveBeenCalledWith('profil.changed', {
      userId: 'u1',
    });
  });

  describe('limite de profil.update par socket', () => {
    const socket = (id = 's1') => ({ id, data: { userId: 'u1' } }) as any;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      redis.publish = jest.fn().mockResolvedValue(1);
    });
    afterEach(() => jest.useRealTimers());

    it('regroupe les demandes rapprochées en un seul envoi différé', async () => {
      await gateway.updateProfil(socket());
      jest.advanceTimersByTime(1000);
      await gateway.updateProfil(socket());
      await gateway.updateProfil(socket());
      expect(redis.publish).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(DELAI_MIN_PROFIL_MS - 1000);
      expect(redis.publish).toHaveBeenCalledTimes(2);
      expect(redis.publish).toHaveBeenLastCalledWith('profil.changed', {
        userId: 'u1',
      });

      await gateway.updateProfil(socket());
      expect(redis.publish).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(DELAI_MIN_PROFIL_MS);
      expect(redis.publish).toHaveBeenCalledTimes(3);
    });

    it('envoie tout de suite une fois la fenêtre écoulée', async () => {
      await gateway.updateProfil(socket());
      jest.advanceTimersByTime(DELAI_MIN_PROFIL_MS);
      await gateway.updateProfil(socket());
      expect(redis.publish).toHaveBeenCalledTimes(2);
    });

    it('limite chaque socket indépendamment, et oublie un socket fermé', async () => {
      (gateway as any).server.in = jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([]),
      }));
      await gateway.updateProfil(socket('s1'));
      await gateway.updateProfil(socket('s2'));
      expect(redis.publish).toHaveBeenCalledTimes(2);

      await gateway.handleDisconnect(socket('s1'));
      await gateway.updateProfil(socket('s1'));
      expect(redis.publish).toHaveBeenCalledWith('profil.changed', {
        userId: 'u1',
      });
      expect(redis.publish).toHaveBeenCalledTimes(4);
    });

    it('journalise un envoi différé en échec', async () => {
      const logger = jest
        .spyOn((gateway as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await gateway.updateProfil(socket());
      redis.publish = jest.fn().mockRejectedValue(new Error('redis'));
      await gateway.updateProfil(socket());
      jest.advanceTimersByTime(DELAI_MIN_PROFIL_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Profil non diffusé'),
      );
    });
  });

  async function brancherRedis() {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    return (channel: string, payload: unknown) =>
      handler(
        channel,
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );
  }

  it('sessions révoquées : revérifie sans cache les seuls sockets de ce compte', async () => {
    const socket = (id: string, token: string) => ({
      id,
      handshake: { auth: { token } },
      data: { userId: 'u1', role: 'utilisateur' },
      emit: jest.fn(),
      disconnect: jest.fn(),
    });
    const ancien = socket('ancien', 'jeton-revoque');
    const courant = socket('courant', 'nouveau-jeton');
    const fetchSockets = jest.fn().mockResolvedValue([ancien, courant]);
    const versUtilisateur = jest.fn().mockReturnValue({ fetchSockets });
    (gateway as any).server = { in: versUtilisateur };
    jwt.verifyTokenFresh.mockImplementation(async (token: string) => {
      if (token === 'jeton-revoque') throw new UnauthorizedException();
      return { id: 'u1', role: 'utilisateur' };
    });
    const publier = await brancherRedis();

    publier('sessions.revoquees', { userId: 'u1' });
    await new Promise((fin) => setImmediate(fin));

    expect(versUtilisateur).toHaveBeenCalledWith('user:u1');
    expect(jwt.verifyToken).not.toHaveBeenCalled();
    expect(ancien.emit).toHaveBeenCalledWith('session.revoquee');
    expect(ancien.disconnect).toHaveBeenCalledWith(true);
    expect(courant.disconnect).not.toHaveBeenCalled();
  });

  it('sessions révoquées : signale une panne Auth sans fermer les sockets', async () => {
    const avertir = jest
      .spyOn((gateway as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const socket = {
      id: 'courant',
      handshake: { auth: { token: 'jeton' } },
      data: { userId: 'u1', role: 'utilisateur' },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    (gateway as any).server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      }),
    };
    jwt.verifyTokenFresh.mockRejectedValue(new Error('Auth indisponible'));
    await gateway.revaliderSocketsUtilisateur('u1');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(avertir).toHaveBeenCalledWith(
      'Authentification indisponible après invalidation : 1 socket(s) gardé(s) sans revérification',
    );
  });
  it('sessions révoquées : ignore un message invalide et journalise un échec', async () => {
    const erreur = jest
      .spyOn((gateway as any).logger, 'error')
      .mockImplementation(() => undefined);
    const avertir = jest
      .spyOn((gateway as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const fetchSockets = jest.fn().mockRejectedValue(new Error('redis'));
    (gateway as any).server = {
      in: jest.fn().mockReturnValue({ fetchSockets }),
    };
    const publier = await brancherRedis();

    publier('sessions.revoquees', { userId: 3 });
    expect(avertir).toHaveBeenCalled();
    expect(fetchSockets).not.toHaveBeenCalled();

    publier('sessions.revoquees', { userId: 'u1' });
    await new Promise((fin) => setImmediate(fin));
    expect(erreur).toHaveBeenCalledWith(
      expect.stringContaining('Revalidation des sockets de u1'),
    );
  });

  it('broadcasts profile changes to every client, ignoring invalid ones', async () => {
    const serverEmit = jest.fn();
    (gateway as any).server = { emit: serverEmit };
    const publier = await brancherRedis();

    publier('profil.changed', { userId: 'u1', pseudo: 'fuite' });
    publier('profil.changed', 'pas du json');
    publier('profil.changed', { userId: 3 });

    expect(serverEmit.mock.calls).toEqual([
      ['profil.changed', { userId: 'u1' }],
    ]);
  });

  it('relaie un état de lecture : DM aux deux personnes, salon à sa room', async () => {
    const publier = await brancherRedis();
    const dm = {
      kind: 'dm',
      targetId: 'u2',
      userId: 'u1',
      lastReadAt: '2026-10-06T12:00:00.000Z',
      lastReadMessageId: null,
    };
    publier('read-state.updated', { ...dm, extra: 'ignoré' });
    expect(to).toHaveBeenLastCalledWith(['user:u1', 'user:u2']);
    expect(emit).toHaveBeenLastCalledWith('read-state.updated', dm);

    publier('read-state.updated', { ...dm, kind: 'room', targetId: 'r1' });
    expect(to).toHaveBeenLastCalledWith('room:r1');
    expect(emit).toHaveBeenCalledTimes(2);
    publier('read-state.updated', { ...dm, lastReadMessageId: 'm1' });
    expect(emit).toHaveBeenLastCalledWith('read-state.updated', {
      ...dm,
      lastReadMessageId: 'm1',
    });
    const ancien: Partial<typeof dm> = { ...dm };
    delete ancien.lastReadMessageId;
    publier('read-state.updated', ancien);
    expect(emit).toHaveBeenLastCalledWith('read-state.updated', dm);
  });

  it.each([
    'pas du json',
    'null',
    { kind: 'groupe', targetId: 't', userId: 'u', lastReadAt: 'd' },
    { kind: 'dm', targetId: 1, userId: 'u', lastReadAt: 'd' },
    { kind: 'dm', targetId: 't', userId: null, lastReadAt: 'd' },
    { kind: 'room', targetId: 't', userId: 'u', lastReadAt: 5 },
    { kind: 'room', targetId: 't', userId: 'u', lastReadAt: 'invalide' },
    {
      kind: 'dm',
      targetId: 't',
      userId: 'u',
      lastReadAt: '2026-01-01T00:00:00Z',
      lastReadMessageId: 1,
    },
  ])('ignore un état de lecture invalide (%p)', async (payload) => {
    const publier = await brancherRedis();
    publier('read-state.updated', payload);
    expect(emit).not.toHaveBeenCalled();
  });

  it('relays a server change to each listed user only', async () => {
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'expulse',
      cibleId: 'u3',
      utilisateurIds: ['u1', 'u3'],
    });

    expect(to.mock.calls).toEqual([['user:u1'], ['user:u3']]);
    expect(emit).toHaveBeenCalledWith('serveur.change', {
      serveurId: 's1',
      raison: 'expulse',
      cibleId: 'u3',
    });
    expect(rooms.oublierServeur).toHaveBeenCalledWith('s1');
  });

  it.each([
    'pas du json',
    'null',
    { serveurId: 1, raison: 'salons', cibleId: null, utilisateurIds: [] },
    { serveurId: 's', raison: 'piratage', cibleId: null, utilisateurIds: [] },
    { serveurId: 's', raison: 'salons', cibleId: 5, utilisateurIds: [] },
    { serveurId: 's', raison: 'salons', cibleId: null, utilisateurIds: 'u1' },
    { serveurId: 's', raison: 'salons', cibleId: null, utilisateurIds: [1] },
    {
      serveurId: 's',
      raison: 'salons',
      cibleId: null,
      tous: 'oui',
      utilisateurIds: [],
    },
  ])('ignores an invalid server change %#', async (payload) => {
    const publier = await brancherRedis();
    publier('serveur.change', payload);
    expect(to).not.toHaveBeenCalled();
  });

  it('refuses a presence update before authentication', async () => {
    redis.publish = jest.fn();
    await expect(
      gateway.updatePresence({ data: {} } as any, { statut: 'en-ligne' }),
    ).rejects.toThrow('Utilisateur non authentifié');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("publishes the caller's own presence and remembers it on the socket", async () => {
    redis.publish = jest.fn().mockResolvedValue(1);
    const client: any = { data: { userId: 'u1' } };
    await expect(
      gateway.updatePresence(client, { statut: 'hors-ligne' }),
    ).resolves.toEqual({ ok: true });
    expect(client.data.presence).toBe('hors-ligne');
    expect(redis.publish).toHaveBeenCalledWith('presence.changed', {
      userId: 'u1',
      statut: 'hors-ligne',
    });
  });

  it('sends a valid presence event to its followers only, and ignores invalid ones', async () => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    const serverEmit = jest.fn();
    const salles: string[] = [];
    const cible: { to: jest.Mock; emit: jest.Mock } = {
      to: jest.fn((salle: string): unknown => {
        salles.push(salle);
        return cible;
      }),
      emit: serverEmit,
    };
    (gateway as any).server = { to: cible.to, emit: jest.fn() };
    await gateway.afterInit();

    handler(
      'presence.changed',
      JSON.stringify({ userId: 'u1', statut: 'en-ligne', extra: 'x' }),
    );
    expect(salles).toEqual(['presence:u1', 'user:u1']);
    expect(serverEmit).toHaveBeenCalledWith('presence.changed', {
      userId: 'u1',
      statut: 'en-ligne',
    });
    expect((gateway as any).server.emit).not.toHaveBeenCalled();

    serverEmit.mockClear();
    handler('presence.changed', 'pas du json');
    handler('presence.changed', 'null');
    handler(
      'presence.changed',
      JSON.stringify({ userId: 1, statut: 'en-ligne' }),
    );
    handler(
      'presence.changed',
      JSON.stringify({ userId: 'u1', statut: 'absent' }),
    );
    expect(serverEmit).not.toHaveBeenCalled();
  });
  it('disconnects when socket auth is null', async () => {
    const client: any = {
      handshake: { auth: null },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('disconnects when socket token is not a string', async () => {
    const client: any = {
      handshake: { auth: { token: 123 } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('disconnects when socket token is empty', async () => {
    const client: any = {
      handshake: { auth: { token: '' } },
      data: {},
      disconnect: jest.fn(),
      emit: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it.each([
    ['null payload', 'null'],
    [
      'invalid id',
      JSON.stringify({ id: 123, senderId: 'u1', recipientId: 'u2' }),
    ],
    [
      'invalid sender',
      JSON.stringify({ id: 'm1', senderId: 123, recipientId: 'u2' }),
    ],
    [
      'invalid recipient',
      JSON.stringify({ id: 'm1', senderId: 'u1', recipientId: 123 }),
    ],
  ])('ignores %s from Redis', async (_name, payload) => {
    let handler!: (channel: string, payload: string) => void;
    redis.subscribe.mockImplementation(
      async (_channels: string[], h: typeof handler) => {
        handler = h;
      },
    );
    await gateway.afterInit();
    handler('private-message.created', payload);
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses joining a room when the socket has no authenticated user', async () => {
    const client: any = { data: {} };
    await expect(gateway.joinRoom(client, { roomId: 'r1' })).rejects.toThrow(
      'Utilisateur non authentifié',
    );
    expect(rooms.verifierAcces).not.toHaveBeenCalled();
  });

  it('refuses joining a room the caller is not a member of', async () => {
    rooms.verifierAcces.mockResolvedValue({ peutLire: false });
    const client: any = { data: { userId: 'u1' }, join: jest.fn() };

    await expect(gateway.joinRoom(client, { roomId: 'r1' })).rejects.toThrow(
      'Vous devez être membre du salon pour rejoindre ce salon',
    );
    expect(client.join).not.toHaveBeenCalled();
  });

  it("joins the room's Socket.IO room for a member", async () => {
    rooms.verifierAcces.mockResolvedValue({ peutLire: true, serveurId: 's1' });
    const client: any = {
      data: { userId: 'u1', role: 'admin', salons: { r0: 's0' } },
      join: jest.fn().mockResolvedValue(undefined),
    };

    await expect(gateway.joinRoom(client, { roomId: 'r1' })).resolves.toEqual({
      joined: true,
    });
    expect(client.join).toHaveBeenCalledWith('room:r1');
    expect(client.data.salons).toEqual({ r0: 's0', r1: 's1' });
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', {
      id: 'u1',
      role: 'admin',
    });
  });

  it("leaves the room's Socket.IO room", async () => {
    const client: any = {
      data: { salons: { r1: 's1', r2: 's1' } },
      leave: jest.fn().mockResolvedValue(undefined),
    };

    await expect(gateway.leaveRoom(client, { roomId: 'r1' })).resolves.toEqual({
      left: true,
    });
    expect(client.leave).toHaveBeenCalledWith('room:r1');
    expect(client.data.salons).toEqual({ r2: 's1' });
  });

  it('leaves a room even if no room was remembered on the socket', async () => {
    const client: any = {
      data: {},
      leave: jest.fn().mockResolvedValue(undefined),
    };

    await expect(gateway.leaveRoom(client, { roomId: 'r1' })).resolves.toEqual({
      left: true,
    });
  });

  it('refuses sending a room message when the socket has no authenticated user', async () => {
    const client: any = { data: {} };
    await expect(
      gateway.sendRoom(client, { roomId: 'r1', content: 'x' }),
    ).rejects.toThrow('Utilisateur non authentifié');
    expect(roomMessages.create).not.toHaveBeenCalled();
  });

  it('delegates sending a room message using the authenticated socket user', async () => {
    roomMessages.create.mockResolvedValue({ id: 'm1' });
    const client: any = { data: { userId: 'u1' } };

    await gateway.sendRoom(client, { roomId: 'r1', content: 'x' });
    expect(roomMessages.create).toHaveBeenCalledWith(
      { id: 'u1', role: 'utilisateur' },
      'r1',
      { content: 'x' },
    );
  });

  it('refuses a typing event when the socket has no authenticated user', () => {
    const client: any = { data: {}, to: jest.fn() };
    expect(() =>
      gateway.typing(client, { scope: 'room', targetId: 'r1', isTyping: true }),
    ).toThrow('Utilisateur non authentifié');
    expect(client.to).not.toHaveBeenCalled();
  });

  it('relays a room-scoped typing event to the room', () => {
    const typingEmit = jest.fn();
    const client: any = {
      data: { userId: 'u1' },
      rooms: new Set(['room:r1']),
      to: jest.fn(() => ({ emit: typingEmit })),
    };

    gateway.typing(client, { scope: 'room', targetId: 'r1', isTyping: true });

    expect(client.to).toHaveBeenCalledWith('room:r1');
    expect(typingEmit).toHaveBeenCalledWith('typing', {
      userId: 'u1',
      scope: 'room',
      targetId: 'r1',
      isTyping: true,
    });
  });

  it('ignores a room-scoped typing event for a room the socket has not joined', () => {
    const client: any = {
      data: { userId: 'u1' },
      rooms: new Set(['user:u1']),
      to: jest.fn(),
    };

    gateway.typing(client, { scope: 'room', targetId: 'r1', isTyping: true });

    expect(client.to).not.toHaveBeenCalled();
  });

  it("limite 'typing' : même état répété ignoré, changement toujours relayé", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const typingEmit = jest.fn();
      const client: any = {
        data: { userId: 'u1' },
        to: jest.fn(() => ({ emit: typingEmit })),
      };
      const saisie = (targetId: string, isTyping: boolean) =>
        gateway.typing(client, { scope: 'dm', targetId, isTyping });

      saisie('u2', true);
      saisie('u2', true);
      saisie('u3', true);
      expect(typingEmit).toHaveBeenCalledTimes(2);

      saisie('u2', false);
      expect(typingEmit).toHaveBeenCalledTimes(3);

      jest.advanceTimersByTime(DELAI_MIN_SAISIE_MS);
      saisie('u2', false);
      expect(typingEmit).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('borne la mémoire de saisie même si un client change continuellement de destinataire', () => {
    const typingEmit = jest.fn();
    const client: any = {
      data: { userId: 'u1' },
      to: jest.fn(() => ({ emit: typingEmit })),
    };
    for (let i = 0; i < 1500; i++) {
      gateway.typing(client, {
        scope: 'dm',
        targetId: `cible-${i}`,
        isTyping: true,
      });
    }
    expect(Object.keys(client.data.saisies)).toHaveLength(1000);
    gateway.typing(client, {
      scope: 'dm',
      targetId: 'cible-1499',
      isTyping: true,
    });
    expect(typingEmit).toHaveBeenCalledTimes(1500);
  });

  it('relays a DM-scoped typing event to the target user', () => {
    const typingEmit = jest.fn();
    const client: any = {
      data: { userId: 'u1' },
      to: jest.fn(() => ({ emit: typingEmit })),
    };

    gateway.typing(client, { scope: 'dm', targetId: 'u2', isTyping: false });

    expect(client.to).toHaveBeenCalledWith('user:u2');
    expect(typingEmit).toHaveBeenCalledWith('typing', {
      userId: 'u1',
      scope: 'dm',
      targetId: 'u2',
      isTyping: false,
    });
  });

  it.each([
    [{ raison: 'expulse', cibleId: 'u3' }, ['u3']],
    [{ raison: 'membres', cibleId: 'u3' }, ['u3']],
    [{ raison: 'membres', cibleId: null }, []],
    [{ raison: 'salons', cibleId: null }, ['u1', 'u3']],
    [{ raison: 'supprime', cibleId: null }, ['u1', 'u3']],
    [{ raison: 'modifie', cibleId: null }, []],
    [{ raison: 'invitation', cibleId: 'u9' }, []],
  ])('revalidates the right users for %o', (partiel, attendu) => {
    expect(
      utilisateursARevalider({
        serveurId: 's1',
        utilisateurIds: ['u1', 'u3'],
        ...partiel,
      } as any),
    ).toEqual(attendu);
  });

  it('« tous » : diffusé à tous les clients, accès revérifiés sur tous les sockets', async () => {
    const serverEmit = jest.fn();
    const perdu = socketDansSalons({ r1: 'defaut', r2: 's2' });
    const garde = {
      ...socketDansSalons({ r3: 'defaut' }),
      data: { userId: 'u4', salons: { r3: 'defaut' } },
    };
    const enCours = {
      ...socketDansSalons({ r1: 'defaut' }),
      data: { salons: { r1: 'defaut' } },
    };
    (gateway as any).server = {
      emit: serverEmit,
      to,
      fetchSockets: jest.fn().mockResolvedValue([perdu, garde, enCours]),
    };
    rooms.verifierAcces.mockImplementation(async (salonId: string) => ({
      peutLire: salonId === 'r3',
    }));
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 'defaut',
      raison: 'salons',
      cibleId: null,
      tous: true,
      utilisateurIds: [],
    });
    await vider();

    expect(serverEmit).toHaveBeenCalledWith('serveur.change', {
      serveurId: 'defaut',
      raison: 'salons',
      cibleId: null,
    });
    expect(to).not.toHaveBeenCalled();
    expect(rooms.oublierServeur).toHaveBeenCalledWith('defaut');
    expect(perdu.leave).toHaveBeenCalledWith('room:r1');
    expect(perdu.data.salons).toEqual({ r2: 's2' });
    expect(garde.leave).not.toHaveBeenCalled();
    expect(enCours.leave).not.toHaveBeenCalled();
  });

  it('« tous » pour un membre : seule la personne visée est revérifiée', async () => {
    const serverEmit = jest.fn();
    const fetchSockets = jest.fn();
    (gateway as any).server = {
      emit: serverEmit,
      fetchSockets,
      in: jest.fn(() => ({ fetchSockets: jest.fn().mockResolvedValue([]) })),
    };
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 'defaut',
      raison: 'membres',
      cibleId: 'u3',
      tous: true,
      utilisateurIds: [],
    });
    await vider();

    expect(serverEmit).toHaveBeenCalled();
    expect(fetchSockets).not.toHaveBeenCalled();
    expect((gateway as any).server.in).toHaveBeenCalledWith('user:u3');
  });

  it("removes an expelled member from the server's rooms only", async () => {
    const socket = socketDansSalons({ r1: 's1', r2: 's2' });
    socketsParUtilisateur.u3 = [socket];
    rooms.verifierAcces.mockResolvedValue({ peutLire: false });
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'expulse',
      cibleId: 'u3',
      utilisateurIds: ['u1', 'u3'],
    });
    await vider();

    expect(rooms.verifierAcces).toHaveBeenCalledTimes(1);
    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', {
      id: 'u3',
      role: 'utilisateur',
    });
    expect(socket.leave).toHaveBeenCalledWith('room:r1');
    expect(socket.emit).toHaveBeenCalledWith('room-message.revoked', {
      roomId: 'r1',
    });
    expect(socket.data.salons).toEqual({ r2: 's2' });
  });

  it('keeps a socket in a room it can still read', async () => {
    const socket = socketDansSalons({ r1: 's1' }, 'admin');
    socketsParUtilisateur.u3 = [socket];
    rooms.verifierAcces.mockResolvedValue({ peutLire: true });
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'membres',
      cibleId: 'u3',
      utilisateurIds: ['u1', 'u3'],
    });
    await vider();

    expect(rooms.verifierAcces).toHaveBeenCalledWith('r1', {
      id: 'u3',
      role: 'admin',
    });
    expect(socket.leave).not.toHaveBeenCalled();
    expect(socket.data.salons).toEqual({ r1: 's1' });
  });

  it('removes the socket from a room that no longer exists (404)', async () => {
    const socket = socketDansSalons({ r1: 's1' });
    socketsParUtilisateur.u1 = [socket];
    rooms.verifierAcces.mockRejectedValue(
      new NotFoundException('Salon introuvable'),
    );
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'salons',
      cibleId: null,
      utilisateurIds: ['u1'],
    });
    await vider();

    expect(socket.leave).toHaveBeenCalledWith('room:r1');
    expect(socket.data.salons).toEqual({});
  });

  it('keeps the socket and warns once when Room-Service is down', async () => {
    const avertir = jest
      .spyOn((gateway as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const socket = socketDansSalons({ r1: 's1', r2: 's1' });
    socketsParUtilisateur.u1 = [socket];
    rooms.verifierAcces.mockRejectedValue(
      new ServiceUnavailableException('Service des salons indisponible'),
    );
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'salons',
      cibleId: null,
      utilisateurIds: ['u1'],
    });
    await vider();

    expect(socket.leave).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith(
      'room-message.revoked',
      expect.anything(),
    );
    expect(socket.data.salons).toEqual({ r1: 's1', r2: 's1' });
    expect(avertir).toHaveBeenCalledTimes(1);
    expect(avertir).toHaveBeenCalledWith(
      expect.stringContaining('Room-Service indisponible : 2 accès'),
    );
  });

  it("removes every socket from a deleted server's rooms without asking Room-Service", async () => {
    const socket = socketDansSalons({ r1: 's1', r2: 's1' });
    socketsParUtilisateur.u1 = [socket, socketDansSalons(undefined)];
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'supprime',
      cibleId: null,
      utilisateurIds: ['u1'],
    });
    await vider();

    expect(rooms.verifierAcces).not.toHaveBeenCalled();
    expect(socket.leave).toHaveBeenCalledWith('room:r1');
    expect(socket.leave).toHaveBeenCalledWith('room:r2');
    expect(socket.data.salons).toEqual({});
  });

  it('logs a revocation failure instead of crashing', async () => {
    const logger = jest
      .spyOn((gateway as any).logger, 'error')
      .mockImplementation(() => undefined);
    (gateway as any).server.in = jest.fn(() => ({
      fetchSockets: jest.fn().mockRejectedValue(new Error('boum')),
    }));
    const publier = await brancherRedis();

    publier('serveur.change', {
      serveurId: 's1',
      raison: 'expulse',
      cibleId: 'u3',
      utilisateurIds: ['u3'],
    });
    await vider();

    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Révocation des salons impossible'),
    );
  });
});
