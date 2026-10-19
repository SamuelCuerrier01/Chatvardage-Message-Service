import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  lireConfigClientAuth,
  ROLES_GLOBAUX,
  RoleGlobal,
} from './partage/client-auth';

export const DUREE_CACHE_DESTINATAIRE_MS = 10 * 60_000;
export const TAILLE_MAX_CACHE_DESTINATAIRES = 10_000;

@Injectable()
export class DestinatairesService {
  private readonly config = lireConfigClientAuth();
  private readonly connus = new Map<string, number>();

  async exigerExistant(id: string, jeton: string): Promise<void> {
    const expireA = this.connus.get(id);
    if (expireA !== undefined) {
      if (expireA > Date.now()) return;
      this.connus.delete(id);
    }

    const reponse = await this.appeler(
      `/api/users/lookup?ids=${encodeURIComponent(id)}`,
      jeton,
      'Vérification du destinataire impossible',
    );
    const trouves = await this.lireJson(reponse);
    if (!Array.isArray(trouves)) {
      throw new BadGatewayException(
        "Réponse invalide du service d'authentification",
      );
    }
    if (
      !trouves.some(
        (u: unknown) =>
          typeof u === 'object' &&
          u !== null &&
          (u as { id?: unknown }).id === id,
      )
    ) {
      throw new NotFoundException('Destinataire introuvable');
    }

    if (this.connus.size >= TAILLE_MAX_CACHE_DESTINATAIRES) {
      this.connus.delete(this.connus.keys().next().value as string);
    }
    this.connus.set(id, Date.now() + DUREE_CACHE_DESTINATAIRE_MS);
  }

  oublier(id: string): void {
    this.connus.delete(id);
  }

  async roleDe(id: string, jeton: string): Promise<RoleGlobal> {
    const reponse = await this.appeler(
      `/api/users/${encodeURIComponent(id)}`,
      jeton,
      "Vérification de l'auteur impossible",
      'Auteur introuvable',
    );
    const corps = await this.lireJson(reponse);
    const role = (corps as { role?: unknown } | null)?.role;
    if (!ROLES_GLOBAUX.includes(role as RoleGlobal)) {
      throw new BadGatewayException(
        "Réponse invalide du service d'authentification",
      );
    }
    return role as RoleGlobal;
  }

  private async appeler(
    chemin: string,
    jeton: string,
    indisponible: string,
    introuvable?: string,
  ): Promise<Response> {
    let reponse: Response;
    try {
      reponse = await fetch(new URL(chemin, this.config.urlService), {
        headers: { Authorization: `Bearer ${jeton}` },
        signal: AbortSignal.timeout(this.config.delaiMs),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Service d'authentification indisponible",
      );
    }
    if (reponse.status === 401 || reponse.status === 403) {
      throw new UnauthorizedException('Jeton invalide ou expiré');
    }
    if (introuvable && reponse.status === 404) {
      throw new NotFoundException(introuvable);
    }
    if (!reponse.ok) {
      throw new ServiceUnavailableException(indisponible);
    }
    return reponse;
  }

  private async lireJson(reponse: Response): Promise<unknown> {
    try {
      return await reponse.json();
    } catch {
      throw new BadGatewayException(
        "Réponse invalide du service d'authentification",
      );
    }
  }
}
