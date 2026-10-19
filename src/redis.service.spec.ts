import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { RedisService } from './redis.service';

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

    expect(Redis).toHaveBeenCalledWith('redis://x', expect.any(Object));
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

  it('publierApresEcriture journalise un échec sans le propager', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    publish.mockRejectedValueOnce(new Error('redis down'));
    connect.mockRejectedValueOnce('hors ligne');
    try {
      const s = new RedisService();
      const autre = new RedisService();

      await expect(
        autre.publierApresEcriture('room-message.created', { id: 'm2' }),
      ).resolves.toBeUndefined();
      (s.publisher as any).status = 'ready';
      await expect(
        s.publierApresEcriture('private-message.created', { id: 'm1' }),
      ).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        "Publication room-message.created perdue après l'écriture en base : hors ligne",
      );
      expect(error).toHaveBeenCalledWith(
        "Publication private-message.created perdue après l'écriture en base : redis down",
      );
    } finally {
      error.mockRestore();
    }
  });
});
