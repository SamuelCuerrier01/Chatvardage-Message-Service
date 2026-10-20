import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InternalDonneesController } from '../internal/internal-donnees.controller';
import { InternalEventsController } from '../internal/internal-events.controller';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { RechercheService } from '../recherche/recherche.service';
import { RoomMessagesModule } from '../room-messages/room-messages.module';
import { ServicesCommunsModule } from '../services-communs.module';
import { MessagesController } from './messages.controller';
import { MessagesGateway } from './messages.gateway';
import { MessagesService } from './messages.service';

@Module({
  imports: [ServicesCommunsModule, RoomMessagesModule],
  controllers: [
    MessagesController,
    InternalEventsController,
    InternalDonneesController,
  ],
  providers: [
    MessagesService,
    MessagesGateway,
    RechercheService,
    JwtAuthGuard,
    InternalTokenGuard,
  ],
})
export class MessagesModule {}
