import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const EN_TETE_JETON_INTERNE = 'x-internal-token';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const attendu = process.env.INTERNAL_SERVICE_TOKEN?.trim();
    if (!attendu) {
      throw new ServiceUnavailableException(
        'INTERNAL_SERVICE_TOKEN non configuré',
      );
    }
    const recu = context.switchToHttp().getRequest<Request>().headers[
      EN_TETE_JETON_INTERNE
    ];
    const tampon = Buffer.from(typeof recu === 'string' ? recu : '');
    const tamponAttendu = Buffer.from(attendu);
    if (
      tampon.length !== tamponAttendu.length ||
      !timingSafeEqual(tampon, tamponAttendu)
    ) {
      throw new UnauthorizedException('Jeton interne invalide');
    }
    return true;
  }
}
