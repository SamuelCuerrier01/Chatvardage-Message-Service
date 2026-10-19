import { Module } from '@nestjs/common';
import { JwtAuthService } from './auth/jwt-auth.service';
import { DestinatairesService } from './destinataires.service';
import { LimiteEnvoiService } from './limite-envoi.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

@Module({
  providers: [
    JwtAuthService,
    DestinatairesService,
    LimiteEnvoiService,
    PrismaService,
    RedisService,
  ],
  exports: [
    JwtAuthService,
    DestinatairesService,
    LimiteEnvoiService,
    PrismaService,
    RedisService,
  ],
})
export class ServicesCommunsModule {}
