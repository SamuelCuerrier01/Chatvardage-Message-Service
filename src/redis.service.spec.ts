import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { DELAI_COMMANDE_MS, RedisService } from './redis.service';

const connect = jest.fn(),
  ping = jest.fn(),
  publish = jest.fn(),
  subscribe = jest.fn(),
  on = jest.fn(),
  removeListener = jest.fn(),
  disconnect = jest.fn();

let instances: any[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const x = {
      status: 'wait',
      connect,
      ping,
      publish,
      subscribe,
      on,
      removeListener,
      disconnect,
    };

    instances.push(x);

    return x;
  }),
}));

describe('RedisService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    instances = [];

    delete process.env.REDIS_URL;

    connect.mockResolvedValue(undefined);
    ping.mockResolvedValue('PONG');
    publish.mockResolvedValue(1);
    subscribe.mockResolvedValue(1);
  });

  it('ping connects waiting publisher', async () => {
    const s = new RedisService();

    await expect(s.ping()).resolves.toBe('PONG');

    expect(connect).toHaveBeenCalled();
  });

  it('publish serializes payload and skips connect when ready', async () => {
    const s = new RedisService();

    (s.publisher as any).status = 'ready';

    await expect(s.publish('c', { a: 1 })).resolves.toBe(1);

    expect(publish).toHaveBeenCalledWith('c', '{"a":1}');
  });

  it('subscribe connects and registers handler', async () => {
    const s = new RedisService();

    const h = jest.fn();

    await s.subscribe(['a', 'b'], h);

    expect(subscribe).toHaveBeenCalledWith('a', 'b');
    expect(on).toHaveBeenCalledWith('message', h);
  });

  it('replaces the previous message handler on repeated subscribe', async () => {
    const s = new RedisService();
    const first = jest.fn();
    const second = jest.fn();

    await s.subscribe(['a'], first);
    await s.subscribe(['a'], second);

    expect(removeListener).toHaveBeenCalledWith('message', first);
    expect(on).toHaveBeenLastCalledWith('message', second);
  });

  it('disconnects non-ended clients', () => {
    const s = new RedisService();

    s.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('does not disconnect ended clients', () => {
    const s = new RedisService();

    (s.publisher as any).status = 'end';
    (s.subscriber as any).status = 'end';

    s.onModuleDestroy();

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('reuses the same connection promise while Redis is connecting', async () => {
    let resolveConnect!: () => void;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const s = new RedisService();
    const first = s.ping();
    const second = s.ping();

    expect(connect).toHaveBeenCalledTimes(1);

    resolveConnect();

    await expect(first).resolves.toBe('PONG');
    await expect(second).resolves.toBe('PONG');
  });

  it('uses configured URL', () => {
    process.env.REDIS_URL = 'redis://x';

    new RedisService();

    expect(Redis).toHaveBeenNthCalledWith(
      1,
      'redis://x',
      expect.objectContaining({
        connectTimeout: DELAI_COMMANDE_MS,
        commandTimeout: DELAI_COMMANDE_MS,
      }),
    );
    expect(Redis).toHaveBeenNthCalledWith(
      2,
      'redis://x',
      expect.not.objectContaining({ commandTimeout: expect.anything() }),
    );
  });

  it('publierApresEcriture publie le contenu sérialisé', async () => {
    const s = new RedisService();

    await expect(
      s.publierApresEcriture('private-message.updated', { id: 'm1' }),
    ).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledWith(
      'private-message.updated',
      JSON.stringify({ id: 'm1' }),
    );
  });

  describe('publierApresEcriture en échec', () => {
    let error: jest.SpyInstance;

    beforeEach(() => {
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => error.mockRestore());

    it('journalise l identifiant du message sans propager l erreur', async () => {
      publish.mockRejectedValueOnce(new Error('redis down'));

      await expect(
        new RedisService().publierApresEcriture('private-message.created', {
          id: 'm1',
          content: 'secret',
        }),
      ).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        `Publication private-message.created perdue après l'écriture en base (id "m1") : "redis down"`,
      );
    });

    it('journalise la lecture concernée quand la connexion échoue', async () => {
      connect.mockRejectedValueOnce('hors ligne');

      await expect(
        new RedisService().publierApresEcriture('read-state.updated', {
          kind: 'dm',
          targetId: 'u2',
          userId: 'u1',
        }),
      ).resolves.toBeUndefined();

      expect(publish).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        `Publication read-state.updated perdue après l'écriture en base (lecture de "u1" sur "u2") : "hors ligne"`,
      );
    });

    it('échappe les retours à la ligne d un identifiant', async () => {
      publish.mockRejectedValueOnce(new Error('redis down'));

      await new RedisService().publierApresEcriture('x', {
        id: 'm1\nfaux enregistrement',
      });

      expect(error).toHaveBeenCalledWith(
        'Publication x perdue après l\'écriture en base (id "m1\\nfaux enregistrement") : "redis down"',
      );
    });

    it.each([undefined, { targetId: 'u2' }])(
      'reste explicite sans identifiant exploitable (%p)',
      async (payload) => {
        publish.mockRejectedValueOnce(new Error('redis down'));

        await new RedisService().publierApresEcriture('x', payload);

        expect(error).toHaveBeenCalledWith(
          `Publication x perdue après l'écriture en base (sans identifiant) : "redis down"`,
        );
      },
    );
  });
});
