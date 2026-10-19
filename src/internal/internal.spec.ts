import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EvenementServeurDto } from './evenement-serveur.dto';
import { InternalEventsController } from './internal-events.controller';
import { InternalTokenGuard } from './internal-token.guard';

const contexte = (enTete?: string | string[]) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: enTete === undefined ? {} : { 'x-internal-token': enTete },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('routes internes', () => {
  const ancien = process.env.INTERNAL_SERVICE_TOKEN;
  afterEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = ancien;
  });

  it('échoue fermé sans INTERNAL_SERVICE_TOKEN', () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(() => new InternalTokenGuard().canActivate(contexte('x'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it.each([undefined, 'court', 'secret-faux-12345', ['secret-interne-12']])(
    'refuse le jeton %p',
    (enTete) => {
      process.env.INTERNAL_SERVICE_TOKEN = 'secret-interne-12';
      expect(() =>
        new InternalTokenGuard().canActivate(contexte(enTete)),
      ).toThrow(UnauthorizedException);
    },
  );

  it('accepte le bon jeton', () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'secret-interne-12';
    expect(
      new InternalTokenGuard().canActivate(contexte('secret-interne-12')),
    ).toBe(true);
  });

  it("publie l'événement de serveur sur Redis, sans doublon de destinataire", async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const controller = new InternalEventsController(redis as any);

    await expect(
      controller.recevoir({
        serveurId: 's1',
        raison: 'expulse',
        cibleId: 'u3',
        utilisateurIds: ['u1', 'u3', 'u1'],
      }),
    ).resolves.toEqual({ accepte: true });
    await controller.recevoir({
      serveurId: 's1',
      raison: 'salons',
      utilisateurIds: ['u1'],
    });

    expect(redis.publish.mock.calls).toEqual([
      [
        'serveur.change',
        {
          serveurId: 's1',
          raison: 'expulse',
          cibleId: 'u3',
          tous: false,
          utilisateurIds: ['u1', 'u3'],
        },
      ],
      [
        'serveur.change',
        {
          serveurId: 's1',
          raison: 'salons',
          cibleId: null,
          tous: false,
          utilisateurIds: ['u1'],
        },
      ],
    ]);
  });

  it('événement « à tous » : sans liste de destinataires', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const controller = new InternalEventsController(redis as any);
    await controller.recevoir({
      serveurId: 'defaut',
      raison: 'salons',
      tous: true,
      utilisateurIds: ['ignore'],
    });
    expect(redis.publish).toHaveBeenCalledWith('serveur.change', {
      serveurId: 'defaut',
      raison: 'salons',
      cibleId: null,
      tous: true,
      utilisateurIds: [],
    });
  });

  it('sessions révoquées : publiées pour que chaque instance ferme les sockets', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const controller = new InternalEventsController(redis as any);
    await expect(
      controller.sessionsRevoquees('11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ accepte: true });
    expect(redis.publish).toHaveBeenCalledWith('sessions.revoquees', {
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it("valide le corps de l'événement", async () => {
    const erreurs = async (corps: object) =>
      (await validate(plainToInstance(EvenementServeurDto, corps))).map(
        (e) => e.property,
      );
    expect(
      await erreurs({ serveurId: 's', raison: 'membres', utilisateurIds: [] }),
    ).toEqual([]);
    expect(
      await erreurs({ serveurId: '', raison: 'piratage', utilisateurIds: [1] }),
    ).toEqual(['serveurId', 'raison', 'utilisateurIds']);
    expect(
      await erreurs({ serveurId: 's', raison: 'salons', tous: true }),
    ).toEqual([]);
    expect(await erreurs({ serveurId: 's', raison: 'salons' })).toEqual([
      'utilisateurIds',
    ]);
    expect(
      await erreurs({ serveurId: 's', raison: 'salons', tous: 'oui' }),
    ).toEqual(['tous', 'utilisateurIds']);
  });
});
