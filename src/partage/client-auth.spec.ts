import {
  BadGatewayException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ClientAuth,
  ConfigClientAuth,
  TAILLE_MAX_CACHE,
  extraireJetonBearer,
  lireConfigClientAuth,
} from './client-auth';

const UTILISATEUR = {
  id: 'u1',
  pseudo: 'alice',
  courriel: 'alice@example.com',
  role: 'utilisateur',
};

const CONFIG: ConfigClientAuth = {
  urlService: 'http://auth.test',
  delaiMs: 3000,
  dureeCacheMs: 10_000,
};

function reponse(statut: number, corps?: unknown): Response {
  return new Response(corps === undefined ? null : JSON.stringify(corps), {
    status: statut,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('lireConfigClientAuth', () => {
  it('applique les valeurs par défaut', () => {
    expect(lireConfigClientAuth({})).toEqual({
      urlService: 'http://localhost:3001',
      delaiMs: 3000,
      dureeCacheMs: 10_000,
    });
  });

  it("lit les variables et ne garde que l'origine", () => {
    expect(
      lireConfigClientAuth({
        AUTH_SERVICE_URL: 'https://auth.example.test/',
        AUTH_SERVICE_TIMEOUT_MS: ' 4500 ',
        AUTH_CACHE_TTL_MS: '0',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      urlService: 'https://auth.example.test',
      delaiMs: 4500,
      dureeCacheMs: 0,
    });
  });

  it('refuse une URL invalide, avec chemin ou paramètres', () => {
    expect(() =>
      lireConfigClientAuth({ AUTH_SERVICE_URL: 'pas une url' }),
    ).toThrow('AUTH_SERVICE_URL doit être une URL valide');
    for (const url of [
      'http://auth.test/api',
      'http://auth.test?x=1',
      'http://auth.test#a',
    ]) {
      expect(() => lireConfigClientAuth({ AUTH_SERVICE_URL: url })).toThrow(
        'ne doit pas contenir de chemin',
      );
    }
  });

  it('exige HTTPS en production seulement', () => {
    expect(() =>
      lireConfigClientAuth({
        AUTH_SERVICE_URL: 'http://auth.test',
        NODE_ENV: 'production',
      }),
    ).toThrow('HTTPS');
    expect(
      lireConfigClientAuth({ AUTH_SERVICE_URL: 'http://auth.test' }).urlService,
    ).toBe('http://auth.test');
  });

  it('refuse un délai ou une durée de cache invalides', () => {
    for (const valeur of ['abc', '-1', '1.5', '']) {
      expect(() =>
        lireConfigClientAuth({ AUTH_SERVICE_TIMEOUT_MS: valeur }),
      ).toThrow('AUTH_SERVICE_TIMEOUT_MS doit être un entier');
    }
    expect(() =>
      lireConfigClientAuth({ AUTH_SERVICE_TIMEOUT_MS: '0' }),
    ).toThrow('AUTH_SERVICE_TIMEOUT_MS doit être supérieur ou égal à 1');
    expect(() => lireConfigClientAuth({ AUTH_CACHE_TTL_MS: 'x' })).toThrow(
      'AUTH_CACHE_TTL_MS doit être un entier',
    );
  });

  it('lit process.env par défaut', () => {
    expect(lireConfigClientAuth().delaiMs).toBeGreaterThan(0);
  });
});

describe('extraireJetonBearer', () => {
  it('extrait le jeton, schéma insensible à la casse', () => {
    expect(extraireJetonBearer('Bearer abc')).toBe('abc');
    expect(extraireJetonBearer('bearer   abc  ')).toBe('abc');
  });

  it('refuse un en-tête absent ou mal formé', () => {
    for (const entete of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b']) {
      expect(() => extraireJetonBearer(entete)).toThrow(UnauthorizedException);
    }
  });
});

describe('ClientAuth', () => {
  let fetchMock: jest.Mock;
  let maintenant: number;
  let avertissement: jest.SpyInstance;
  let erreurJournal: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn(() => Promise.resolve(reponse(200, UTILISATEUR)));
    global.fetch = fetchMock;
    maintenant = 1_000;
    avertissement = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    erreurJournal = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function client(config: Partial<ConfigClientAuth> = {}): ClientAuth {
    return new ClientAuth({ ...CONFIG, ...config }, () => maintenant);
  }

  it("valide le jeton auprès d'Authentification", async () => {
    await expect(client().authentifier('Bearer jwt')).resolves.toEqual(
      UTILISATEUR,
    );
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://auth.test/api/auth/me');
    expect(init.headers).toEqual({ Authorization: 'Bearer jwt' });
  });

  it('ne garde que les champs utiles de la réponse', async () => {
    fetchMock.mockResolvedValueOnce(
      reponse(200, { ...UTILISATEUR, cree_le: 'x', autre: 1 }),
    );
    await expect(client().verifierJeton('jwt')).resolves.toEqual(UTILISATEUR);
  });

  it('mémorise un jeton validé pendant la durée du cache', async () => {
    const auth = client();
    await auth.verifierJeton('jwt');
    maintenant += 9_999;
    await auth.verifierJeton('jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    maintenant += 1;
    await auth.verifierJeton('jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('revérifie sans le cache quand des sessions viennent d’être révoquées', async () => {
    const auth = client();
    await auth.verifierJeton('jwt');
    fetchMock.mockResolvedValueOnce(reponse(401, { erreur: 'révoqué' }));
    await expect(auth.verifierJetonSansCache('jwt')).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.tailleCache).toBe(0);
  });

  it('ne réutilise pas une réponse en cours antérieure à la révocation', async () => {
    const auth = client();
    let terminer!: (reponse: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        terminer = resolve;
      }),
    );
    const ancienne = auth.verifierJeton('jwt');
    fetchMock.mockResolvedValueOnce(reponse(401));
    await expect(auth.verifierJetonSansCache('jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    terminer(reponse(200, UTILISATEUR));
    await ancienne;
    expect(auth.tailleCache).toBe(0);
    await auth.verifierJeton('jwt');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ne mémorise rien avec une durée de cache nulle', async () => {
    const auth = client({ dureeCacheMs: 0 });
    await auth.verifierJeton('jwt');
    await auth.verifierJeton('jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.tailleCache).toBe(0);
  });

  it('distingue les jetons', async () => {
    const auth = client();
    await auth.verifierJeton('a');
    await auth.verifierJeton('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ne fait qu’un appel pour des validations simultanées', async () => {
    const auth = client();
    const [a, b] = await Promise.all([
      auth.verifierJeton('jwt'),
      auth.verifierJeton('jwt'),
    ]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ne mémorise pas un refus', async () => {
    fetchMock.mockResolvedValueOnce(reponse(401));
    const auth = client();
    await expect(auth.verifierJeton('jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(auth.verifierJeton('jwt')).resolves.toEqual(UTILISATEUR);
  });

  it('oublie l’entrée la plus ancienne quand le cache est plein', async () => {
    const auth = client();
    for (let i = 0; i < TAILLE_MAX_CACHE + 1; i += 1) {
      await auth.verifierJeton(`jwt-${i}`);
    }
    expect(auth.tailleCache).toBe(TAILLE_MAX_CACHE);
    fetchMock.mockClear();
    await auth.verifierJeton('jwt-0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, UnauthorizedException],
    [403, ForbiddenException],
    [500, ServiceUnavailableException],
  ])('traduit un statut %i', async (statut, exception) => {
    fetchMock.mockResolvedValueOnce(reponse(statut));
    await expect(client().verifierJeton('jwt')).rejects.toBeInstanceOf(
      exception,
    );
  });

  it('répond 503 si Authentification est injoignable ou trop lente', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client().verifierJeton('jwt')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(erreurJournal).toHaveBeenCalled();

    const delai = new Error('trop long');
    delai.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(delai);
    await expect(client().verifierJeton('jwt')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(avertissement).toHaveBeenCalled();
  });

  it('répond 502 si la réponse est illisible ou incomplète', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('pas du json', { status: 200 }),
    );
    await expect(client().verifierJeton('jwt')).rejects.toBeInstanceOf(
      BadGatewayException,
    );

    for (const corps of [
      null,
      [],
      'texte',
      { ...UTILISATEUR, id: ' ' },
      { ...UTILISATEUR, pseudo: 1 },
      { ...UTILISATEUR, courriel: '' },
      { ...UTILISATEUR, role: 'roi' },
      { ...UTILISATEUR, role: 'moderateur' },
    ]) {
      fetchMock.mockResolvedValueOnce(reponse(200, corps));
      await expect(client().verifierJeton('jwt')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    }
  });

  it('lit la configuration de l’environnement par défaut', () => {
    expect(new ClientAuth()).toBeInstanceOf(ClientAuth);
  });
});
