import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../auth/admin.guard';
import { RoomMessagesController } from './room-messages.controller';

describe('RoomMessagesController', () => {
  let service: any;
  let controller: RoomMessagesController;
  let lecture: any;
  const req: any = { auth: { id: 'u1', role: 'utilisateur' } };
  const adminReq: any = {
    auth: { id: 'admin', role: 'admin' },
    headers: { authorization: 'Bearer jwt-admin' },
  };

  beforeEach(() => {
    service = {
      create: jest.fn(),
      createForAdmin: jest.fn(),
      history: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    lecture = {
      marquerSalonLu: jest.fn().mockResolvedValue('etat'),
      lecteursSalon: jest.fn().mockResolvedValue(['l']),
    };
    controller = new RoomMessagesController(service, lecture);
  });

  it('delegates an admin room message with the selected author', async () => {
    service.createForAdmin.mockResolvedValue(1);

    await expect(
      controller.createForAdmin(adminReq, 'r1', {
        authorId: 'u1',
        content: 'x',
      }),
    ).resolves.toBe(1);
    expect(service.createForAdmin).toHaveBeenCalledWith(
      adminReq.auth,
      'r1',
      { authorId: 'u1', content: 'x' },
      'jwt-admin',
    );
  });

  it('reserves createForAdmin to admins (AdminGuard)', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        Object.getOwnPropertyDescriptor(
          RoomMessagesController.prototype,
          'createForAdmin',
        )?.value,
      ),
    ).toEqual([AdminGuard]);
  });

  it('delegates authenticated CRUD operations', async () => {
    const query = { limit: 50 };
    service.create.mockResolvedValue(1);
    service.history.mockResolvedValue([]);
    service.findOne.mockResolvedValue(1);
    service.update.mockResolvedValue(1);
    service.remove.mockResolvedValue(undefined);

    expect(await controller.create(req, 'r1', { content: 'x' })).toBe(1);
    expect(await controller.history(req, 'r1', query)).toEqual([]);
    expect(await controller.findOne(req, 'r1', 'm')).toBe(1);
    expect(await controller.update(req, 'r1', 'm', { content: 'y' })).toBe(1);
    expect(await controller.remove(req, 'r1', 'm')).toEqual({ deleted: true });

    expect(service.create).toHaveBeenCalledWith(req.auth, 'r1', {
      content: 'x',
    });
    expect(service.history).toHaveBeenCalledWith(req.auth, 'r1', query);
    expect(service.findOne).toHaveBeenCalledWith(req.auth, 'r1', 'm');
    expect(service.update).toHaveBeenCalledWith(req.auth, 'r1', 'm', {
      content: 'y',
    });
    expect(service.remove).toHaveBeenCalledWith(req.auth, 'r1', 'm');
  });

  it('délègue le marquage comme lu avec l’identité authentifiée', async () => {
    await expect(controller.markRead(req, 'r1', {})).resolves.toBe('etat');
    expect(lecture.marquerSalonLu).toHaveBeenCalledWith(
      req.auth,
      'r1',
      undefined,
    );
    await expect(controller.readStates(req, 'r1')).resolves.toEqual({
      lecteurs: ['l'],
    });
    expect(lecture.lecteursSalon).toHaveBeenCalledWith(req.auth, 'r1');
  });
});
