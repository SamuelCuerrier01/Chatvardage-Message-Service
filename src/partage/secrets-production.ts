export const LONGUEUR_MIN_JETON_INTERNE = 32;

export const MOTS_DE_PASSE_DE_DEVELOPPEMENT = [
  'postgres',
  'chatvardage',
  'auth_service_dev',
  'room_service_dev',
  'message_service_dev',
  'config_service_dev',
  'chatvardage_redis_dev',
];

export type ExigencesSecrets = {
  jetonInterne?: boolean;
  urlsAvecMotDePasse?: string[];
};

export function motDePasseUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const motDePasse = new URL(url).password;
    return motDePasse ? decodeURIComponent(motDePasse) : null;
  } catch {
    return null;
  }
}

export function problemesSecretsProduction(
  exigences: ExigencesSecrets,
  env: NodeJS.ProcessEnv,
): string[] {
  if (env.NODE_ENV?.trim() !== 'production') return [];
  const problemes: string[] = [];

  if (exigences.jetonInterne) {
    const jeton = env.INTERNAL_SERVICE_TOKEN?.trim() ?? '';
    if (jeton.length < LONGUEUR_MIN_JETON_INTERNE) {
      problemes.push(
        `INTERNAL_SERVICE_TOKEN doit contenir au moins ${LONGUEUR_MIN_JETON_INTERNE} caractères`,
      );
    }
  }

  for (const variable of exigences.urlsAvecMotDePasse ?? []) {
    const motDePasse = motDePasseUrl(env[variable]);
    if (motDePasse && MOTS_DE_PASSE_DE_DEVELOPPEMENT.includes(motDePasse)) {
      problemes.push(
        `le mot de passe de ${variable} est une valeur de développement`,
      );
    }
  }
  return problemes;
}

export function verifierSecretsProduction(
  exigences: ExigencesSecrets,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problemes = problemesSecretsProduction(exigences, env);
  if (problemes.length > 0) {
    throw new Error(
      `Secrets de développement refusés en production (NODE_ENV=production) : ${problemes.join(' ; ')}`,
    );
  }
}
