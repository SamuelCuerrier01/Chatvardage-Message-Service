import { Injectable } from '@nestjs/common';
import {
  ClientAuth,
  UtilisateurAuthentifie,
  extraireJetonBearer,
} from '../partage/client-auth';

export type AuthenticatedUser = UtilisateurAuthentifie;

@Injectable()
export class JwtAuthService {
  private readonly client = new ClientAuth();

  bearerToken(authorization?: string): string {
    return extraireJetonBearer(authorization);
  }

  verifyToken(token: string): Promise<AuthenticatedUser> {
    return this.client.verifierJeton(token);
  }

  verifyTokenFresh(token: string): Promise<AuthenticatedUser> {
    return this.client.verifierJetonSansCache(token);
  }
}
