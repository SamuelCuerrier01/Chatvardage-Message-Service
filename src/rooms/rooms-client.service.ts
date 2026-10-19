import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/jwt-auth.service';

export const TAILLE_MAX_CACHE_ACCES = 10_000;

export function dureeCacheAccesMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const brut = (env.ROOM_ACCESS_CACHE_TTL_MS ?? '10000').trim();
  if (!/^\d+$/.test(brut)) {
    throw new Error(
      `ROOM_ACCESS_CACHE_TTL_MS doit être un entier : "${env.ROOM_ACCESS_CACHE_TTL_MS}"`,
    );
  }
  return Number(brut);
}

export type ConfigRoomsClient = {
  urlService: string;
  jetonInterne: string | null;
  delaiMs: number;
  dureeCacheMs: number;
};

export function lireConfigRoomsClient(
  env: NodeJS.ProcessEnv = process.env,
): ConfigRoomsClient {
  const brute = env.ROOM_SERVICE_URL ?? 'http://localhost:3003';
  let url: URL;
  try {
    url = new URL(brute.trim().replace(/\/+$/, ''));
  } catch {
    throw new Error(`ROOM_SERVICE_URL doit être une URL valide : "${brute}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `ROOM_SERVICE_URL doit utiliser HTTP ou HTTPS : "${brute}"`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `ROOM_SERVICE_URL ne doit pas contenir de chemin ou paramètres : "${brute}"`,
    );
  }

  const delaiBrut = (env.ROOM_SERVICE_TIMEOUT_MS ?? '3000').trim();
  if (!/^\d+$/.test(delaiBrut) || Number(delaiBrut) < 1) {
    throw new Error(
      `ROOM_SERVICE_TIMEOUT_MS doit être un entier supérieur ou égal à 1 : "${env.ROOM_SERVICE_TIMEOUT_MS}"`,
    );
  }

  return {
    urlService: url.origin,
    jetonInterne: env.INTERNAL_SERVICE_TOKEN?.trim() || null,
    delaiMs: Number(delaiBrut),
    dureeCacheMs: dureeCacheAccesMs(env),
  };
}

export type AccesSalon = {
  salonId: string;
  serveurId: string;
  estMembre: boolean;
  peutLire: boolean;
  peutEcrire: boolean;
  peutModerer: boolean;
};

export type SalonLisible = {
  salonId: string;
  serveurId: string;
  depuis: Date | null;
};

export type Acteur = Pick<AuthenticatedUser, 'id' | 'role'>;

@Injectable()
export class RoomsClientService {
  private readonly config = lireConfigRoomsClient();
  private readonly cache = new Map<
    string,
    { acces: AccesSalon; expireA: number }
  >();
  private readonly cacheListes = new Map<
    string,
    { salons: SalonLisible[]; expireA: number }
  >();

  private generationInvalidation = 0;

  async verifierAcces(roomId: string, acteur: Acteur): Promise<AccesSalon> {
    const clef = `${roomId}|${acteur.id}|${acteur.role}`;
    const entree = this.cache.get(clef);
    if (entree) {
      if (entree.expireA > Date.now()) return entree.acces;
      this.cache.delete(clef);
    }
    for (let tentative = 0; tentative < 2; tentative += 1) {
      const generation = this.generationInvalidation;
      const acces = await this.demanderAcces(roomId, acteur);
      if (generation !== this.generationInvalidation) continue;
      this.memoriser(this.cache, clef, { acces });
      return acces;
    }
    throw new ServiceUnavailableException(
      'Droits des salons modifiés pendant la validation',
    );
  }

  async salonsLisibles(acteur: Acteur): Promise<SalonLisible[]> {
    const clef = `${acteur.id}|${acteur.role}`;
    const entree = this.cacheListes.get(clef);
    if (entree) {
      if (entree.expireA > Date.now()) return entree.salons;
      this.cacheListes.delete(clef);
    }
    for (let tentative = 0; tentative < 2; tentative += 1) {
      const generation = this.generationInvalidation;
      const corps = await this.lireJson(
        `/api/internal/users/${encodeURIComponent(acteur.id)}` +
          `/channels?role=${encodeURIComponent(acteur.role)}`,
        null,
      );
      if (generation !== this.generationInvalidation) continue;
      const salons = lireSalonsLisibles(corps);
      this.memoriser(this.cacheListes, clef, { salons });
      return salons;
    }
    throw new ServiceUnavailableException(
      'Droits des salons modifiés pendant la validation',
    );
  }

  oublierServeur(serveurId: string): void {
    this.generationInvalidation += 1;
    for (const [clef, { acces }] of this.cache) {
      if (acces.serveurId === serveurId) this.cache.delete(clef);
    }
    this.cacheListes.clear();
  }

  private memoriser<T>(
    cache: Map<string, T & { expireA: number }>,
    clef: string,
    valeur: T,
  ): void {
    if (this.config.dureeCacheMs <= 0) return;
    if (cache.size >= TAILLE_MAX_CACHE_ACCES) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(clef, {
      ...valeur,
      expireA: Date.now() + this.config.dureeCacheMs,
    });
  }

  private async demanderAcces(
    roomId: string,
    acteur: Acteur,
  ): Promise<AccesSalon> {
    const acces = (await this.lireJson(
      `/api/internal/channels/${encodeURIComponent(roomId)}` +
        `/access/${encodeURIComponent(acteur.id)}?role=${encodeURIComponent(acteur.role)}`,
      'Salon introuvable',
    )) as Partial<AccesSalon> | null;

    if (
      typeof acces !== 'object' ||
      acces === null ||
      typeof acces.salonId !== 'string' ||
      typeof acces.serveurId !== 'string' ||
      typeof acces.estMembre !== 'boolean' ||
      typeof acces.peutLire !== 'boolean' ||
      typeof acces.peutEcrire !== 'boolean' ||
      (acces.peutModerer !== undefined &&
        typeof acces.peutModerer !== 'boolean')
    ) {
      throw new BadGatewayException('Réponse invalide du service des salons');
    }

    return {
      salonId: acces.salonId,
      serveurId: acces.serveurId,
      estMembre: acces.estMembre,
      peutLire: acces.peutLire,
      peutEcrire: acces.peutEcrire,
      peutModerer: acces.peutModerer ?? false,
    };
  }

  private async lireJson(
    chemin: string,
    introuvable: string | null,
  ): Promise<unknown> {
    const jeton = this.config.jetonInterne;
    if (!jeton) {
      throw new ServiceUnavailableException(
        'INTERNAL_SERVICE_TOKEN non configuré',
      );
    }

    let response: Response;

    try {
      response = await fetch(`${this.config.urlService}${chemin}`, {
        headers: { 'x-internal-token': jeton },
        signal: AbortSignal.timeout(this.config.delaiMs),
      });
    } catch {
      throw new ServiceUnavailableException('Service des salons indisponible');
    }

    if (response.status === 404 && introuvable !== null) {
      throw new NotFoundException(introuvable);
    }

    if (!response.ok) {
      throw new ServiceUnavailableException('Validation du salon impossible');
    }

    try {
      return await response.json();
    } catch {
      throw new BadGatewayException('Réponse invalide du service des salons');
    }
  }
}

function lireSalonsLisibles(corps: unknown): SalonLisible[] {
  const invalide = () =>
    new BadGatewayException('Réponse invalide du service des salons');
  const salons = (corps as { salons?: unknown } | null)?.salons;
  if (!Array.isArray(salons)) throw invalide();
  return salons.map((brut: unknown) => {
    const salon = brut as Partial<Record<keyof SalonLisible, unknown>> | null;
    if (
      typeof salon?.salonId !== 'string' ||
      typeof salon.serveurId !== 'string' ||
      (salon.depuis !== null && typeof salon.depuis !== 'string')
    ) {
      throw invalide();
    }
    const depuis = salon.depuis === null ? null : new Date(salon.depuis);
    if (depuis !== null && Number.isNaN(depuis.getTime())) throw invalide();
    return { salonId: salon.salonId, serveurId: salon.serveurId, depuis };
  });
}
