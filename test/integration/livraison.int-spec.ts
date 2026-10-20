import { Prisma, PrismaClient } from '@prisma/client';
import { MessagesService } from '../../src/messages/messages.service';

if (!/\/[^/?]+_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'DATABASE_URL doit désigner une base jetable dont le nom finit par _test',
  );
}

describe('confirmation de livraison (PostgreSQL réel)', () => {
  const prisma = new PrismaClient();
  const redis = { publish: jest.fn().mockResolvedValue(1) };
  const creerService = (
    client: ConstructorParameters<typeof MessagesService>[0],
  ) =>
    new MessagesService(
      client,
      redis as unknown as ConstructorParameters<typeof MessagesService>[1],
      {} as ConstructorParameters<typeof MessagesService>[2],
      {} as ConstructorParameters<typeof MessagesService>[3],
      {} as ConstructorParameters<typeof MessagesService>[4],
    );
  const service = creerService(
    prisma as ConstructorParameters<typeof MessagesService>[0],
  );
  beforeEach(async () => {
    jest.restoreAllMocks();
    redis.publish.mockClear();
    await prisma.privateMessage.deleteMany();
  });
  afterAll(() => prisma.$disconnect());

  it('deux appareils confirment une seule fois sans modifier la date du texte', async () => {
    const message = await prisma.privateMessage.create({
      data: {
        senderId: 'a',
        recipientId: 'b',
        content: 'bonjour',
        updatedAt: new Date('2026-01-01'),
      },
    });
    const [premier, second] = await Promise.all([
      service.markDelivered('b', message.id),
      service.markDelivered('b', message.id),
    ]);
    expect(premier.deliveredAt).toBeInstanceOf(Date);
    expect(second.deliveredAt).toEqual(premier.deliveredAt);
    expect(premier.updatedAt).toEqual(message.updatedAt);
    expect(second.updatedAt).toEqual(message.updatedAt);
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('une édition après la lecture préalable conserve sa date et son contenu', async () => {
    const message = await prisma.privateMessage.create({
      data: {
        senderId: 'a',
        recipientId: 'b',
        content: 'avant',
        updatedAt: new Date('2026-01-01'),
      },
    });
    const lire = prisma.privateMessage.findUnique.bind(prisma.privateMessage);
    const dateEdition = new Date('2026-02-01');
    const clientPendantEdition = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      privateMessage: {
        findUnique: async (requete: Prisma.PrivateMessageFindUniqueArgs) => {
          const ancien = await lire(requete);
          await prisma.privateMessage.update({
            where: { id: message.id },
            data: { content: 'après', updatedAt: dateEdition },
          });
          return ancien;
        },
      },
    };
    const servicePendantEdition = creerService(
      clientPendantEdition as unknown as ConstructorParameters<
        typeof MessagesService
      >[0],
    );
    const livré = await servicePendantEdition.markDelivered('b', message.id);
    expect(livré.content).toBe('après');
    expect(livré.updatedAt).toEqual(dateEdition);
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });
});
