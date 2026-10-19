import { HttpException, HttpStatus } from '@nestjs/common';
import {
  FENETRE_ENVOI_MS,
  LimiteEnvoiService,
  MAX_ENVOIS_PAR_FENETRE,
} from './limite-envoi.service';

describe('LimiteEnvoiService', () => {
  let service: LimiteEnvoiService;

  beforeEach(() => {
    service = new LimiteEnvoiService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  function envoyer(userId: string, fois: number, temps: number): void {
    for (let i = 0; i < fois; i += 1) service.verifier(userId, temps);
  }

  it("accepte jusqu'à la limite, puis refuse avec une 429", () => {
    envoyer('u1', MAX_ENVOIS_PAR_FENETRE, 1000);

    let erreur: unknown;
    try {
      service.verifier('u1', 1000);
    } catch (e) {
      erreur = e;
    }
    expect(erreur).toBeInstanceOf(HttpException);
    expect((erreur as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it("utilise l'heure courante par défaut", () => {
    for (let i = 0; i < MAX_ENVOIS_PAR_FENETRE; i += 1) service.verifier('u1');
    expect(() => service.verifier('u1')).toThrow(HttpException);
  });

  it('compte chaque utilisateur séparément', () => {
    envoyer('u1', MAX_ENVOIS_PAR_FENETRE, 1000);
    expect(() => service.verifier('u2', 1000)).not.toThrow();
  });

  it('accepte de nouveau une fois la fenêtre glissée', () => {
    envoyer('u1', MAX_ENVOIS_PAR_FENETRE, 1000);
    expect(() => service.verifier('u1', 1000 + FENETRE_ENVOI_MS)).not.toThrow();
  });

  it('un envoi refusé ne prolonge pas le blocage', () => {
    envoyer('u1', MAX_ENVOIS_PAR_FENETRE, 1000);
    expect(() => service.verifier('u1', 5000)).toThrow(HttpException);
    expect(() => service.verifier('u1', 1000 + FENETRE_ENVOI_MS)).not.toThrow();
  });

  it('le nettoyage oublie les utilisateurs inactifs seulement', () => {
    service.verifier('ancien', 1000);
    service.verifier('recent', 1000 + FENETRE_ENVOI_MS);
    service.nettoyer(1000 + FENETRE_ENVOI_MS);

    envoyer('ancien', MAX_ENVOIS_PAR_FENETRE, 1000 + FENETRE_ENVOI_MS);
    envoyer('recent', MAX_ENVOIS_PAR_FENETRE - 1, 1000 + FENETRE_ENVOI_MS);
    expect(() => service.verifier('recent', 1000 + FENETRE_ENVOI_MS)).toThrow(
      HttpException,
    );
  });

  it('le nettoyage tourne périodiquement', () => {
    jest.useFakeTimers();
    try {
      const periodique = new LimiteEnvoiService();
      const nettoyer = jest.spyOn(periodique, 'nettoyer');
      jest.advanceTimersByTime(FENETRE_ENVOI_MS);
      expect(nettoyer).toHaveBeenCalledTimes(1);
      periodique.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
