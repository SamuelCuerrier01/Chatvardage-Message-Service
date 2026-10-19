import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

export const MAX_ENVOIS_PAR_FENETRE = 10;
export const FENETRE_ENVOI_MS = 10_000;

@Injectable()
export class LimiteEnvoiService implements OnModuleDestroy {
  private readonly envois = new Map<string, number[]>();
  private readonly nettoyage: ReturnType<typeof setInterval>;

  constructor() {
    this.nettoyage = setInterval(() => this.nettoyer(), FENETRE_ENVOI_MS);
    this.nettoyage.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.nettoyage);
  }

  verifier(userId: string, maintenant = Date.now()): void {
    const recents = (this.envois.get(userId) ?? []).filter(
      (temps) => maintenant - temps < FENETRE_ENVOI_MS,
    );
    if (recents.length >= MAX_ENVOIS_PAR_FENETRE) {
      this.envois.set(userId, recents);
      throw new HttpException(
        'Trop de messages envoyés, réessayez dans quelques secondes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recents.push(maintenant);
    this.envois.set(userId, recents);
  }

  nettoyer(maintenant = Date.now()): void {
    for (const [userId, temps] of this.envois) {
      const dernier = temps[temps.length - 1];
      if (dernier === undefined || maintenant - dernier >= FENETRE_ENVOI_MS) {
        this.envois.delete(userId);
      }
    }
  }
}
