import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EtatLectureService } from '../lecture/etat-lecture.service';
import { RoomsClientService } from '../rooms/rooms-client.service';
import { ServicesCommunsModule } from '../services-communs.module';
import { RoomMessagesController } from './room-messages.controller';
import { RoomMessagesService } from './room-messages.service';

@Module({
  imports: [ServicesCommunsModule],
  controllers: [RoomMessagesController],
  providers: [
    RoomMessagesService,
    RoomsClientService,
    EtatLectureService,
    JwtAuthGuard,
  ],
  exports: [RoomMessagesService, RoomsClientService, EtatLectureService],
})
export class RoomMessagesModule {}
