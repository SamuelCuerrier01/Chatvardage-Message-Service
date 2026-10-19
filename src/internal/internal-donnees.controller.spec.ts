import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DestinatairesService } from '../destinataires.service';
import { EtatLectureService } from '../lecture/etat-lecture.service';
import { MessagesService } from '../messages/messages.service';
import { RoomMessagesService } from '../room-messages/room-messages.service';
import {
  InternalDonneesController,
  SalonsSupprimesDto,
} from './internal-donnees.controller';

describe('InternalDonneesController', () => {
  const messages = { supprimerUtilisateur: jest.fn().mockResolvedValue(2) };
  const roomMessages = {
    purgerSalons: jest.fn().mockResolvedValue(5),
    supprimerAuteur: jest.fn().mockResolvedValue(3),
  };
  const destinataires = { oublier: jest.fn() };
  const lecture = {
    purgerSalons: jest.fn().mockResolvedValue(undefined),
    supprimerUtilisateur: jest.fn().mockResolvedValue(undefined),
  };
  const controleur = new InternalDonneesController(
    messages as unknown as MessagesService,
    roomMessages as unknown as RoomMessagesService,
    destinataires as unknown as DestinatairesService,
    lecture as unknown as EtatLectureService,
  );

  it('efface les messages des salons supprimés', async () => {
    await expect(
      controleur.salonsSupprimes({ salonIds: ['r1', 'r2'] }),
    ).resolves.toEqual({ messagesSalons: 5 });
    expect(roomMessages.purgerSalons).toHaveBeenCalledWith(['r1', 'r2']);
    expect(lecture.purgerSalons).toHaveBeenCalledWith(['r1', 'r2']);
  });

  it("efface les messages privés et de salon d'un compte supprimé", async () => {
    await expect(controleur.supprimerUtilisateur('u1')).resolves.toEqual({
      messagesPrives: 2,
      messagesSalons: 3,
    });
    expect(messages.supprimerUtilisateur).toHaveBeenCalledWith('u1');
    expect(roomMessages.supprimerAuteur).toHaveBeenCalledWith('u1');
    expect(lecture.supprimerUtilisateur).toHaveBeenCalledWith('u1');
    expect(destinataires.oublier).toHaveBeenCalledWith('u1');
  });

  it('valide la liste des salons (500 au plus)', async () => {
    const erreurs = async (corps: object) =>
      (await validate(plainToInstance(SalonsSupprimesDto, corps))).map(
        (e) => e.property,
      );
    expect(await erreurs({ salonIds: ['r1'] })).toEqual([]);
    expect(await erreurs({ salonIds: [1] })).toEqual(['salonIds']);
    expect(await erreurs({})).toEqual(['salonIds']);
    expect(
      await erreurs({ salonIds: Array.from({ length: 501 }, () => 'r') }),
    ).toEqual(['salonIds']);
  });
});
