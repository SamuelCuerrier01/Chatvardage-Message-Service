import {
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  RoomsClientService,
  TAILLE_MAX_CACHE_ACCES,
  dureeCacheAccesMs,
  lireConfigRoomsClient,
} from './rooms-client.service';

describe('RoomsClientService', () => {
  const originalFetch = global.fetch;
  const acteur = { id: 'u1', role: 'utilisateur' as const };
  const acces = {
    salonId: 'r1',
    serveurId: 's1',
    estMembre: true,
    peutLire: true,
    peutEcrire: false,
    peutModerer: true,
  };
  let service: RoomsClientService;

  const repondre = (reponse: object) => {
    global.fetch = jest.fn().mockResolvedValue(reponse);
  };

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'secret-interne';
    service = new RoomsClientService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ROOM_SERVICE_URL;
    delete process.env.ROOM_SERVICE_TIMEOUT_MS;
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("asks Room-Service's internal route with the shared token and the global role", async () => {
    process.env.ROOM_SERVICE_URL = 'http://room-service:3003/';
    service = new RoomsClientService();
    repondre({ ok: true, status: 200, json: async () => acces });

    await expect(
      service.verifierAcces('r 1', { id: 'u/1', role: 'admin' }),
    ).resolves.toEqual(acces);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://room-service:3003/api/internal/channels/r%201/access/u%2F1?role=admin',
      expect.objectContaining({
        headers: { 'x-internal-token': 'secret-interne' },
        signal: expect.anything(),
      }),
    );
  });

  it.each([undefined, '   '])(
    'refuses to call Room-Service without INTERNAL_SERVICE_TOKEN (%p)',
    async (valeur) => {
      if (valeur === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = valeur;
      service = new RoomsClientService();
      global.fetch = jest.fn();

      await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('uses the default timeout (3000 ms)', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    repondre({ ok: true, status: 200, json: async () => acces });

    await service.verifierAcces('r1', acteur);

    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    timeoutSpy.mockRestore();
  });

  it('uses a valid configured timeout', async () => {
    process.env.ROOM_SERVICE_TIMEOUT_MS = '1500';
    service = new RoomsClientService();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    repondre({ ok: true, status: 200, json: async () => acces });

    await service.verifierAcces('r1', acteur);

    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  describe('configuration validée au démarrage', () => {
    it('valeurs par défaut', () => {
      expect(lireConfigRoomsClient({})).toEqual({
        urlService: 'http://localhost:3003',
        jetonInterne: null,
        delaiMs: 3000,
        dureeCacheMs: 10_000,
      });
    });

    it('valeurs fournies (URL et jeton nettoyés)', () => {
      expect(
        lireConfigRoomsClient({
          ROOM_SERVICE_URL: ' https://room-service:3003/ ',
          INTERNAL_SERVICE_TOKEN: ' secret ',
          ROOM_SERVICE_TIMEOUT_MS: '1500',
          ROOM_ACCESS_CACHE_TTL_MS: '0',
        }),
      ).toEqual({
        urlService: 'https://room-service:3003',
        jetonInterne: 'secret',
        delaiMs: 1500,
        dureeCacheMs: 0,
      });
    });

    it.each([
      ['pas une URL', 'room-service', /URL valide/],
      ['autre protocole', 'ftp://room-service', /HTTP ou HTTPS/],
      ['avec un chemin', 'http://room-service:3003/api', /chemin/],
      ['avec des paramètres', 'http://room-service:3003?x=1', /chemin/],
    ])('refuse ROOM_SERVICE_URL %s', (_cas, url, erreur) => {
      expect(() => lireConfigRoomsClient({ ROOM_SERVICE_URL: url })).toThrow(
        erreur,
      );
    });

    it.each(['abc', '0', '-10', '1.5'])(
      'refuse ROOM_SERVICE_TIMEOUT_MS=%s (au lieu de retomber en silence sur 3000)',
      (valeur) => {
        expect(() =>
          lireConfigRoomsClient({ ROOM_SERVICE_TIMEOUT_MS: valeur }),
        ).toThrow(/ROOM_SERVICE_TIMEOUT_MS/);
      },
    );

    it('une configuration invalide empêche la construction du service', () => {
      process.env.ROOM_SERVICE_URL = 'pas-une-url';
      expect(() => new RoomsClientService()).toThrow(/ROOM_SERVICE_URL/);
    });
  });

  it('maps 404 to not found', async () => {
    repondre({ ok: false, status: 404 });
    await expect(
      service.verifierAcces('missing', acteur),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps network errors to unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([401, 500, 503])(
    'maps a %s status (e.g. wrong internal token) to unavailable',
    async (status) => {
      repondre({ ok: false, status });
      await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );

  it('maps a non-JSON response to a bad gateway', async () => {
    repondre({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('invalid json');
      },
    });
    await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it.each([
    { ...acces, salonId: 1 },
    { ...acces, serveurId: undefined },
    { ...acces, estMembre: 'oui' },
    { ...acces, peutLire: null },
    { ...acces, peutEcrire: 1 },
    { ...acces, peutModerer: 'oui' },
  ])('maps an invalid access payload %# to a bad gateway', async (payload) => {
    repondre({ ok: true, status: 200, json: async () => payload });
    await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('peutModerer absent (Room-Service plus ancien) : faux', async () => {
    const ancien: Partial<typeof acces> = { ...acces };
    delete ancien.peutModerer;
    repondre({ ok: true, status: 200, json: async () => ancien });
    await expect(service.verifierAcces('r1', acteur)).resolves.toEqual({
      ...ancien,
      peutModerer: false,
    });
  });

  describe('cache des accès', () => {
    const accesOk = () =>
      Promise.resolve({ ok: true, status: 200, json: async () => acces });

    it('mémorise un accès obtenu', async () => {
      global.fetch = jest.fn(accesOk) as unknown as typeof fetch;
      await service.verifierAcces('r1', acteur);
      await service.verifierAcces('r1', acteur);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await service.verifierAcces('r1', { id: 'u2', role: 'utilisateur' });
      await service.verifierAcces('r1', { id: 'u1', role: 'admin' });
      await service.verifierAcces('r2', acteur);
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it("redemande l'accès une fois l'entrée expirée", async () => {
      global.fetch = jest.fn(accesOk) as unknown as typeof fetch;
      const maintenant = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        await service.verifierAcces('r1', acteur);
        maintenant.mockReturnValue(1_000 + 10_000);
        await service.verifierAcces('r1', acteur);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      } finally {
        maintenant.mockRestore();
      }
    });

    it("oublie les accès d'un serveur qui a changé, pas des autres", async () => {
      global.fetch = jest.fn(accesOk) as unknown as typeof fetch;
      await service.verifierAcces('r1', acteur);
      service.oublierServeur('autre');
      await service.verifierAcces('r1', acteur);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      service.oublierServeur('s1');
      await service.verifierAcces('r1', acteur);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('ne mémorise pas une erreur', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockImplementation(accesOk);
      await expect(service.verifierAcces('r1', acteur)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.verifierAcces('r1', acteur)).resolves.toEqual(acces);
    });

    it("oublie l'entrée la plus ancienne quand le cache est plein", async () => {
      global.fetch = jest.fn(accesOk) as unknown as typeof fetch;
      for (let i = 0; i <= TAILLE_MAX_CACHE_ACCES; i += 1) {
        await service.verifierAcces(`r${i}`, acteur);
      }
      await service.verifierAcces('r0', acteur);
      expect(global.fetch).toHaveBeenCalledTimes(TAILLE_MAX_CACHE_ACCES + 2);
    });

    it('ne mémorise rien avec ROOM_ACCESS_CACHE_TTL_MS=0', async () => {
      process.env.ROOM_ACCESS_CACHE_TTL_MS = '0';
      try {
        const sansCache = new RoomsClientService();
        global.fetch = jest.fn(accesOk) as unknown as typeof fetch;
        await sansCache.verifierAcces('r1', acteur);
        await sansCache.verifierAcces('r1', acteur);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.ROOM_ACCESS_CACHE_TTL_MS;
      }
    });

    it('refuse une durée de cache invalide', () => {
      expect(dureeCacheAccesMs({})).toBe(10_000);
      expect(dureeCacheAccesMs({ ROOM_ACCESS_CACHE_TTL_MS: ' 500 ' })).toBe(
        500,
      );
      expect(() =>
        dureeCacheAccesMs({ ROOM_ACCESS_CACHE_TTL_MS: 'dix' }),
      ).toThrow('ROOM_ACCESS_CACHE_TTL_MS doit être un entier');
      expect(dureeCacheAccesMs()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('salons lisibles', () => {
    const corps = {
      salons: [
        { salonId: 'r1', serveurId: 's1', depuis: '2026-03-04T05:06:07.000Z' },
        { salonId: 'r2', serveurId: 'defaut', depuis: null },
      ],
    };
    const attendu = [
      {
        salonId: 'r1',
        serveurId: 's1',
        depuis: new Date('2026-03-04T05:06:07.000Z'),
      },
      { salonId: 'r2', serveurId: 'defaut', depuis: null },
    ];
    const listeOk = () =>
      Promise.resolve({ ok: true, status: 200, json: async () => corps });

    it('interroge la route interne avec le rôle global et convertit les dates', async () => {
      global.fetch = jest.fn(listeOk) as unknown as typeof fetch;
      await expect(
        service.salonsLisibles({ id: 'u/1', role: 'admin' }),
      ).resolves.toEqual(attendu);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3003/api/internal/users/u%2F1/channels?role=admin',
        expect.objectContaining({
          headers: { 'x-internal-token': 'secret-interne' },
        }),
      );
    });

    it('mémorise la liste et l’oublie au moindre changement de serveur', async () => {
      global.fetch = jest.fn(listeOk) as unknown as typeof fetch;
      await service.salonsLisibles(acteur);
      await service.salonsLisibles(acteur);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      service.oublierServeur('nouveau-serveur');
      await service.salonsLisibles(acteur);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('redemande une liste expirée', async () => {
      global.fetch = jest.fn(listeOk) as unknown as typeof fetch;
      const maintenant = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      try {
        await service.salonsLisibles(acteur);
        maintenant.mockReturnValue(1_000 + 10_001);
        await service.salonsLisibles(acteur);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      } finally {
        maintenant.mockRestore();
      }
    });

    it('un 404 (Room-Service sans cette route) est une panne : 503', async () => {
      repondre({ ok: false, status: 404, json: async () => ({}) });
      await expect(service.salonsLisibles(acteur)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it.each([
      ['sans liste', {}],
      ['corps nul', null],
      ['salon nul', { salons: [null] }],
      ['salonId manquant', { salons: [{ serveurId: 's', depuis: null }] }],
      ['serveurId manquant', { salons: [{ salonId: 'r', depuis: null }] }],
      ['depuis absent', { salons: [{ salonId: 'r', serveurId: 's' }] }],
      [
        'date invalide',
        { salons: [{ salonId: 'r', serveurId: 's', depuis: 'hier' }] },
      ],
    ])('refuse une réponse invalide (%s) : 502', async (_cas, reponse) => {
      repondre({ ok: true, status: 200, json: async () => reponse });
      await expect(service.salonsLisibles(acteur)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  it.each(['liste', 'acces'])(
    'redemande les droits invalidés pendant une réponse %s en cours',
    async (type) => {
      let resoudre!: (valeur: unknown) => void;
      const nouveaux = { ...acces, peutLire: false, peutModerer: false };
      global.fetch = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resoudre = r;
            }),
        )
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => (type === 'liste' ? { salons: [] } : nouveaux),
        });
      const lire = () =>
        type === 'liste'
          ? service.salonsLisibles(acteur)
          : service.verifierAcces('r1', acteur);
      const enCours = lire();
      service.oublierServeur('s1');
      resoudre({
        ok: true,
        status: 200,
        json: async () =>
          type === 'liste'
            ? { salons: [{ salonId: 'r1', serveurId: 's1', depuis: null }] }
            : acces,
      });
      const attendu = type === 'liste' ? [] : nouveaux;
      await expect(enCours).resolves.toEqual(attendu);
      await expect(lire()).resolves.toEqual(attendu);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['liste', 'acces'])(
    'refuse une réponse %s si les droits changent aussi pendant la relance',
    async (type) => {
      global.fetch = jest.fn().mockImplementation(async () => {
        service.oublierServeur('s1');
        return {
          ok: true,
          status: 200,
          json: async () => (type === 'liste' ? { salons: [] } : acces),
        };
      });
      const lire = () =>
        type === 'liste'
          ? service.salonsLisibles(acteur)
          : service.verifierAcces('r1', acteur);
      await expect(lire()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      repondre({
        ok: true,
        status: 200,
        json: async () => (type === 'liste' ? { salons: [] } : acces),
      });
      await lire();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );
});
