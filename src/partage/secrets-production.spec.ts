import {
  LONGUEUR_MIN_JETON_INTERNE,
  MOTS_DE_PASSE_DE_DEVELOPPEMENT,
  motDePasseUrl,
  problemesSecretsProduction,
  verifierSecretsProduction,
} from './secrets-production';

const JETON_SUR = 'x'.repeat(LONGUEUR_MIN_JETON_INTERNE);
const TOUT = {
  jetonInterne: true,
  urlsAvecMotDePasse: ['DATABASE_URL', 'REDIS_URL'],
};

describe('secrets de production', () => {
  it('ne vérifie rien hors production (valeurs de développement acceptées)', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      expect(
        problemesSecretsProduction(TOUT, {
          NODE_ENV,
          INTERNAL_SERVICE_TOKEN: 'chatvardage_internal_dev',
          DATABASE_URL: 'postgresql://room_service:room_service_dev@db/rooms',
        }),
      ).toEqual([]);
    }
  });

  it('accepte des secrets propres en production', () => {
    expect(() =>
      verifierSecretsProduction(TOUT, {
        NODE_ENV: ' production ',
        INTERNAL_SERVICE_TOKEN: JETON_SUR,
        DATABASE_URL: 'postgresql://svc:un-vrai-secret@db:5432/base',
        REDIS_URL: 'redis://:un-autre-secret@redis:6379',
      }),
    ).not.toThrow();
  });

  it('liste tous les problèmes en production', () => {
    expect(
      problemesSecretsProduction(TOUT, {
        NODE_ENV: 'production',
        INTERNAL_SERVICE_TOKEN: 'chatvardage_internal_dev',
        DATABASE_URL: 'postgresql://svc:message_service_dev@db/base',
        REDIS_URL: 'redis://:chatvardage_redis_dev@redis:6379',
      }),
    ).toEqual([
      `INTERNAL_SERVICE_TOKEN doit contenir au moins ${LONGUEUR_MIN_JETON_INTERNE} caractères`,
      'le mot de passe de DATABASE_URL est une valeur de développement',
      'le mot de passe de REDIS_URL est une valeur de développement',
    ]);
  });

  it('refuse un jeton interne absent', () => {
    expect(
      problemesSecretsProduction(
        { jetonInterne: true },
        { NODE_ENV: 'production' },
      ),
    ).toHaveLength(1);
  });

  it('ne vérifie que ce que le service exige', () => {
    expect(
      problemesSecretsProduction(
        { urlsAvecMotDePasse: ['DATABASE_URL'] },
        {
          NODE_ENV: 'production',
          INTERNAL_SERVICE_TOKEN: 'court',
          REDIS_URL: 'redis://:chatvardage_redis_dev@redis:6379',
          DATABASE_URL: 'postgresql://svc:un-vrai-secret@db/base',
        },
      ),
    ).toEqual([]);
    expect(problemesSecretsProduction({}, { NODE_ENV: 'production' })).toEqual(
      [],
    );
  });

  it('refuse chaque mot de passe de développement de l’Infra', () => {
    for (const motDePasse of MOTS_DE_PASSE_DE_DEVELOPPEMENT) {
      expect(
        problemesSecretsProduction(
          { urlsAvecMotDePasse: ['DATABASE_URL'] },
          {
            NODE_ENV: 'production',
            DATABASE_URL: `postgresql://svc:${motDePasse}@db/base`,
          },
        ),
      ).toHaveLength(1);
    }
  });

  it('verifierSecretsProduction lève une erreur qui liste les problèmes', () => {
    expect(() =>
      verifierSecretsProduction(
        { jetonInterne: true },
        { NODE_ENV: 'production', INTERNAL_SERVICE_TOKEN: 'court' },
      ),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
  });

  it('lit process.env par défaut', () => {
    const avant = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(() => verifierSecretsProduction(TOUT)).not.toThrow();
    } finally {
      if (avant === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = avant;
    }
  });

  describe('motDePasseUrl', () => {
    it('extrait et décode le mot de passe', () => {
      expect(motDePasseUrl('postgresql://u:p%40ss@h/db')).toBe('p@ss');
    });

    it('retourne null sans URL, sans mot de passe ou URL invalide', () => {
      expect(motDePasseUrl(undefined)).toBeNull();
      expect(motDePasseUrl('postgresql://u@h/db')).toBeNull();
      expect(motDePasseUrl('pas une url')).toBeNull();
    });
  });
});
