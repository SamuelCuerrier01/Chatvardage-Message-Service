import {
  ForbiddenException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PrivateMessage, RoomMessage } from '@prisma/client';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { RemoteSocket, Server, Socket } from 'socket.io';
import { AuthenticatedUser, JwtAuthService } from '../auth/jwt-auth.service';
import {
  RAISONS_SERVEUR,
  RaisonServeur,
} from '../internal/evenement-serveur.dto';
import {
  SERVEUR_CHANNEL,
  SESSIONS_CHANNEL,
} from '../internal/internal-events.controller';
import { RedisService } from '../redis.service';
import { RoomMessagesService } from '../room-messages/room-messages.service';
import { RoomIdDto } from '../room-messages/dto/room-id.dto';
import {
  CANAL_LECTURE,
  EvenementLecture,
} from '../lecture/etat-lecture.service';
import { SendRoomMessageDto } from '../room-messages/dto/send-room-message.dto';
import { Acteur, RoomsClientService } from '../rooms/rooms-client.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { ExceptionsWsFilter } from './exceptions-ws.filter';
import { PresenceDto, SuivrePresenceDto } from './dto/presence.dto';
import { TypingDto } from './dto/typing.dto';
import { MessagesService } from './messages.service';

interface SocketData {
  userId?: string;
  role?: AuthenticatedUser['role'];
  presence?: PresenceEvent['statut'];
  dernierSuivi?: number;
  salons?: Record<string, string>;
  saisies?: Record<string, { isTyping: boolean; temps: number }>;
}

interface EvenementsVersClient {
  'connexion.prete': () => void;
  typing: (payload: {
    userId: string;
    scope: 'room' | 'dm';
    targetId: string;
    isTyping: boolean;
  }) => void;
  'room-message.revoked': (payload: { roomId: string }) => void;
  'session.revoquee': () => void;
}

type AuthenticatedSocket = Socket<
  Record<string, never>,
  EvenementsVersClient,
  Record<string, never>,
  SocketData
>;

interface PrivateMessageEvent {
  id: string;
  senderId: string;
  recipientId: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface RoomMessageEvent {
  id: string;
  roomId: string;
  authorId: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
}

const PRIVATE_MESSAGE_CHANNELS = [
  'private-message.created',
  'private-message.updated',
  'private-message.deleted',
  'private-message.delivered',
];

const PRESENCE_CHANNEL = 'presence.changed';
const PROFIL_CHANNEL = 'profil.changed';
export const DELAI_MIN_PROFIL_MS = 5000;
export const DELAI_MIN_SAISIE_MS = 1000;
export const DELAI_MIN_PRESENCE_MS = 1000;
export const DELAI_MIN_SUIVI_PRESENCE_MS = 1000;
export const INTERVALLE_REVALIDATION_MS = 60_000;

interface EvenementServeur {
  serveurId: string;
  raison: RaisonServeur;
  cibleId: string | null;
  tous?: boolean;
  utilisateurIds: string[];
}

interface PresenceEvent {
  userId: string;
  statut: 'en-ligne' | 'hors-ligne';
}

const LECTURE_CHANNEL = CANAL_LECTURE;

const ROOM_MESSAGE_CHANNELS = [
  'room-message.created',
  'room-message.updated',
  'room-message.deleted',
];

export function utilisateursARevalider(event: EvenementServeur): string[] {
  switch (event.raison) {
    case 'expulse':
    case 'membres':
      return event.cibleId ? [event.cibleId] : [];
    case 'salons':
    case 'supprime':
      return event.utilisateurIds;
    default:
      return [];
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
): void {
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  callback(null, origin === undefined || allowedOrigins.includes(origin));
}

function estJetonRefuse(erreur: unknown): boolean {
  return (
    erreur instanceof UnauthorizedException ||
    erreur instanceof ForbiddenException ||
    erreur instanceof WsException
  );
}

@UseFilters(new ExceptionsWsFilter())
@WebSocketGateway({
  namespace: '/messages',
  cors: {
    origin: isAllowedOrigin,
    credentials: false,
  },
})
export class MessagesGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger(MessagesGateway.name);
  private minuteurRevalidation?: ReturnType<typeof setInterval>;
  private revalidationEnCours = false;
  private readonly limitesProfil = new Map<
    string,
    { dernierEnvoi: number; envoiDiffere?: ReturnType<typeof setTimeout> }
  >();
  private readonly limitesPresence = new Map<
    string,
    {
      dernierEnvoi: number;
      statut: PresenceEvent['statut'];
      envoiDiffere?: ReturnType<typeof setTimeout>;
    }
  >();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly messages: MessagesService,
    private readonly redis: RedisService,
    private readonly jwt: JwtAuthService,
    private readonly roomMessages: RoomMessagesService,
    private readonly rooms: RoomsClientService,
  ) {}

  async afterInit(): Promise<void> {
    await this.redis.subscribe(
      [
        ...PRIVATE_MESSAGE_CHANNELS,
        ...ROOM_MESSAGE_CHANNELS,
        PRESENCE_CHANNEL,
        PROFIL_CHANNEL,
        SERVEUR_CHANNEL,
        LECTURE_CHANNEL,
        SESSIONS_CHANNEL,
      ],
      (channel, payload) => this.broadcastRedisEvent(channel, payload),
    );
    this.minuteurRevalidation = setInterval(() => {
      this.revaliderSockets().catch((erreur: unknown) => {
        this.logger.error(`Revalidation des sockets: ${String(erreur)}`);
      });
    }, INTERVALLE_REVALIDATION_MS);
    this.minuteurRevalidation.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.minuteurRevalidation);
  }

  async revaliderSockets(): Promise<void> {
    if (this.revalidationEnCours) return;
    this.revalidationEnCours = true;
    try {
      await this.revaliderTousLesSockets();
    } finally {
      this.revalidationEnCours = false;
    }
  }

  private async revaliderTousLesSockets(): Promise<void> {
    const sockets =
      (await this.server.fetchSockets()) as unknown as RemoteSocket<
        EvenementsVersClient,
        SocketData
      >[];
    let gardesSansVerification = 0;
    for (const socket of sockets) {
      if (!(await this.revaliderSocket(socket, false))) {
        gardesSansVerification += 1;
      }
    }
    if (gardesSansVerification > 0) {
      this.logger.warn(
        `Authentification indisponible : ${gardesSansVerification} socket(s) gardé(s) sans revérification`,
      );
    }
  }

  async revaliderSocketsUtilisateur(userId: string): Promise<void> {
    const sockets = (await this.server
      .in(`user:${userId}`)
      .fetchSockets()) as unknown as RemoteSocket<
      EvenementsVersClient,
      SocketData
    >[];
    let gardesSansVerification = 0;
    for (const socket of sockets) {
      if (!(await this.revaliderSocket(socket, true)))
        gardesSansVerification += 1;
    }
    if (gardesSansVerification > 0) {
      this.logger.warn(
        `Authentification indisponible après invalidation : ${gardesSansVerification} socket(s) gardé(s) sans revérification`,
      );
    }
  }

  private async revaliderSocket(
    socket: RemoteSocket<EvenementsVersClient, SocketData>,
    sansCache: boolean,
  ): Promise<boolean> {
    if (!socket.data.userId) return true;
    try {
      const jeton = this.readSocketToken(socket);
      const user = sansCache
        ? await this.jwt.verifyTokenFresh(jeton)
        : await this.jwt.verifyToken(jeton);
      socket.data.role = user.role;
      return true;
    } catch (erreur) {
      if (!estJetonRefuse(erreur)) return false;
      this.logger.warn(`Jeton refusé, socket déconnecté [${socket.id}]`);
      socket.emit('session.revoquee');
      socket.disconnect(true);
      return true;
    }
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const token = this.readSocketToken(client);
      const user = await this.jwt.verifyToken(token);

      client.data.userId = user.id;
      client.data.role = user.role;
      await client.join(`user:${user.id}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'erreur inconnue';

      this.logger.warn(`Connexion refusée [${client.id}]: ${message}`);
      if (estJetonRefuse(error)) client.emit('session.revoquee');
      client.disconnect(true);
      return;
    }
    client.emit('connexion.prete');
  }

  async handleDisconnect(client: AuthenticatedSocket): Promise<void> {
    this.logger.debug(`Client déconnecté: ${client.id}`);
    this.limitesProfil.delete(client.id);
    clearTimeout(this.limitesPresence.get(client.id)?.envoiDiffere);
    this.limitesPresence.delete(client.id);
    const userId = client.data?.userId;
    if (!userId) return;

    try {
      const restants = await this.server.in(`user:${userId}`).fetchSockets();
      if (restants.length > 0) return;
      await this.redis.publish(PRESENCE_CHANNEL, {
        userId,
        statut: 'hors-ligne',
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'erreur inconnue';
      this.logger.warn(`Présence hors ligne non diffusée: ${message}`);
    }
  }

  @SubscribeMessage('profil.update')
  async updateProfil(
    @ConnectedSocket() client: AuthenticatedSocket,
  ): Promise<{ ok: true }> {
    const userId = this.requireUserId(client);
    const maintenant = Date.now();
    const limite = this.limitesProfil.get(client.id);
    if (!limite || maintenant - limite.dernierEnvoi >= DELAI_MIN_PROFIL_MS) {
      this.limitesProfil.set(client.id, { dernierEnvoi: maintenant });
      await this.redis.publish(PROFIL_CHANNEL, { userId });
      return { ok: true };
    }
    limite.envoiDiffere ??= setTimeout(
      () => {
        limite.envoiDiffere = undefined;
        limite.dernierEnvoi = Date.now();
        this.redis.publish(PROFIL_CHANNEL, { userId }).catch((erreur) => {
          this.logger.warn(`Profil non diffusé: ${String(erreur)}`);
        });
      },
      DELAI_MIN_PROFIL_MS - (maintenant - limite.dernierEnvoi),
    );
    return { ok: true };
  }

  @SubscribeMessage('presence.suivre')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async suivrePresence(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: SuivrePresenceDto,
  ): Promise<{ enLigne: string[] }> {
    const userId = this.requireUserId(client);
    const maintenant = Date.now();
    if (
      client.data.dernierSuivi !== undefined &&
      maintenant - client.data.dernierSuivi < DELAI_MIN_SUIVI_PRESENCE_MS
    ) {
      throw new WsException('Trop de demandes de présence');
    }
    client.data.dernierSuivi = maintenant;

    const suivis = new Set(dto.ids.filter((id) => id !== userId));
    for (const room of client.rooms) {
      if (room.startsWith('presence:') && !suivis.has(room.slice(9))) {
        await client.leave(room);
      }
    }
    await client.join([...suivis].map((id) => `presence:${id}`));

    const enLigne: string[] = [];
    await Promise.all(
      [...suivis].map(async (id) => {
        const sockets = await this.server.in(`user:${id}`).fetchSockets();
        if (
          sockets.some(
            (socket) => (socket.data as SocketData).presence === 'en-ligne',
          )
        ) {
          enLigne.push(id);
        }
      }),
    );
    return { enLigne };
  }

  @SubscribeMessage('presence.update')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async updatePresence(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: PresenceDto,
  ): Promise<{ ok: true }> {
    const userId = this.requireUserId(client);
    client.data.presence = dto.statut;
    const maintenant = Date.now();
    const limite = this.limitesPresence.get(client.id);
    if (!limite || maintenant - limite.dernierEnvoi >= DELAI_MIN_PRESENCE_MS) {
      this.limitesPresence.set(client.id, {
        dernierEnvoi: maintenant,
        statut: dto.statut,
      });
      await this.redis.publish(PRESENCE_CHANNEL, {
        userId,
        statut: dto.statut,
      });
      return { ok: true };
    }
    limite.statut = dto.statut;
    limite.envoiDiffere ??= setTimeout(
      () => {
        limite.envoiDiffere = undefined;
        limite.dernierEnvoi = Date.now();
        this.redis
          .publish(PRESENCE_CHANNEL, { userId, statut: limite.statut })
          .catch((erreur) => {
            this.logger.warn(`Présence non diffusée: ${String(erreur)}`);
          });
      },
      DELAI_MIN_PRESENCE_MS - (maintenant - limite.dernierEnvoi),
    );
    return { ok: true };
  }

  @SubscribeMessage('private-message.send')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async send(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: CreateMessageDto,
  ): Promise<PrivateMessage> {
    const senderId = this.requireUserId(client);

    return this.messages.create(senderId, dto, this.readSocketToken(client));
  }

  @SubscribeMessage('room-message.join')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async joinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: RoomIdDto,
  ): Promise<{ joined: true }> {
    const acteur = this.requireActeur(client);

    const acces = await this.rooms.verifierAcces(dto.roomId, acteur);
    if (!acces.peutLire) {
      throw new WsException(
        'Vous devez être membre du salon pour rejoindre ce salon',
      );
    }

    await client.join(`room:${dto.roomId}`);
    client.data.salons = {
      ...client.data.salons,
      [dto.roomId]: acces.serveurId,
    };
    return { joined: true };
  }

  @SubscribeMessage('room-message.leave')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async leaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: RoomIdDto,
  ): Promise<{ left: true }> {
    await client.leave(`room:${dto.roomId}`);
    delete client.data.salons?.[dto.roomId];
    return { left: true };
  }

  @SubscribeMessage('room-message.send')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async sendRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: SendRoomMessageDto,
  ): Promise<RoomMessage> {
    const acteur = this.requireActeur(client);

    return this.roomMessages.create(acteur, dto.roomId, {
      content: dto.content,
    });
  }

  @SubscribeMessage('typing')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  typing(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() dto: TypingDto,
  ): void {
    const userId = this.requireUserId(client);

    const room =
      dto.scope === 'room' ? `room:${dto.targetId}` : `user:${dto.targetId}`;

    if (dto.scope === 'room' && !client.rooms.has(room)) {
      return;
    }

    const maintenant = Date.now();
    const saisies = (client.data.saisies ??= {});
    const precedente = saisies[room];
    if (
      precedente?.isTyping === dto.isTyping &&
      maintenant - precedente.temps < DELAI_MIN_SAISIE_MS
    ) {
      return;
    }
    saisies[room] = { isTyping: dto.isTyping, temps: maintenant };

    client.to(room).emit('typing', {
      userId,
      scope: dto.scope,
      targetId: dto.targetId,
      isTyping: dto.isTyping,
    });
  }

  private requireActeur(client: AuthenticatedSocket): Acteur {
    return {
      id: this.requireUserId(client),
      role: client.data.role ?? 'utilisateur',
    };
  }

  private requireUserId(client: AuthenticatedSocket): string {
    const userId = client.data.userId;

    if (!userId) {
      throw new WsException('Utilisateur non authentifié');
    }

    return userId;
  }

  private readSocketToken(client: { handshake: { auth: unknown } }): string {
    const auth: unknown = client.handshake.auth;

    if (typeof auth !== 'object' || auth === null || !('token' in auth)) {
      throw new WsException('Token JWT manquant');
    }

    const token = (auth as { token?: unknown }).token;

    if (typeof token !== 'string' || token.length === 0) {
      throw new WsException('Token JWT manquant');
    }

    return token;
  }

  private broadcastRedisEvent(channel: string, payload: string): void {
    if (PRIVATE_MESSAGE_CHANNELS.includes(channel)) {
      this.broadcastPrivateMessageEvent(channel, payload);
      return;
    }

    if (ROOM_MESSAGE_CHANNELS.includes(channel)) {
      this.broadcastRoomMessageEvent(channel, payload);
      return;
    }

    if (channel === PRESENCE_CHANNEL) {
      this.broadcastPresenceEvent(payload);
      return;
    }

    if (channel === PROFIL_CHANNEL) {
      this.broadcastProfilEvent(payload);
      return;
    }

    if (channel === SESSIONS_CHANNEL) {
      const event = this.lireJson(payload) as { userId?: unknown } | null;
      if (typeof event?.userId !== 'string') {
        this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
        return;
      }
      this.revaliderSocketsUtilisateur(event.userId).catch(
        (erreur: unknown) => {
          this.logger.error(
            `Revalidation des sockets de ${event.userId as string}: ${String(erreur)}`,
          );
        },
      );
      return;
    }

    if (channel === SERVEUR_CHANNEL) {
      this.broadcastServeurEvent(payload);
      return;
    }

    if (channel === LECTURE_CHANNEL) {
      this.broadcastLectureEvent(payload);
      return;
    }

    this.logger.warn(`Canal Redis invalide ignoré: ${channel}`);
  }

  private broadcastPrivateMessageEvent(channel: string, payload: string): void {
    let message: PrivateMessageEvent;

    try {
      const parsed: unknown = JSON.parse(payload);

      if (!this.isPrivateMessageEvent(parsed)) {
        this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
        return;
      }

      message = parsed;
    } catch {
      this.logger.warn(`Événement Redis invalide ignoré: ${payload}`);
      return;
    }

    this.server.to(`user:${message.senderId}`).emit(channel, message);

    if (message.recipientId !== message.senderId) {
      this.server.to(`user:${message.recipientId}`).emit(channel, message);
    }
  }

  private broadcastRoomMessageEvent(channel: string, payload: string): void {
    let message: RoomMessageEvent;

    try {
      const parsed: unknown = JSON.parse(payload);

      if (!this.isRoomMessageEvent(parsed)) {
        this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
        return;
      }

      message = parsed;
    } catch {
      this.logger.warn(`Événement Redis invalide ignoré: ${payload}`);
      return;
    }

    this.server.to(`room:${message.roomId}`).emit(channel, message);
  }

  private lireJson(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }

  private broadcastProfilEvent(payload: string): void {
    const event = this.lireJson(payload) as { userId?: unknown } | null;
    if (typeof event?.userId !== 'string') {
      this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
      return;
    }
    this.server.emit(PROFIL_CHANNEL, { userId: event.userId });
  }

  private broadcastLectureEvent(payload: string): void {
    const event = this.lireJson(payload) as Partial<EvenementLecture> | null;
    if (
      (event?.kind !== 'dm' && event?.kind !== 'room') ||
      typeof event.targetId !== 'string' ||
      typeof event.userId !== 'string' ||
      typeof event.lastReadAt !== 'string' ||
      Number.isNaN(Date.parse(event.lastReadAt)) ||
      (event.lastReadMessageId != null &&
        typeof event.lastReadMessageId !== 'string')
    ) {
      this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
      return;
    }
    const message: EvenementLecture = {
      kind: event.kind,
      targetId: event.targetId,
      userId: event.userId,
      lastReadAt: event.lastReadAt,
      lastReadMessageId: event.lastReadMessageId ?? null,
    };
    if (message.kind === 'room') {
      this.server.to(`room:${message.targetId}`).emit(LECTURE_CHANNEL, message);
    } else {
      this.server
        .to([`user:${message.userId}`, `user:${message.targetId}`])
        .emit(LECTURE_CHANNEL, message);
    }
  }

  private broadcastServeurEvent(payload: string): void {
    const event = this.lireJson(payload) as Partial<EvenementServeur> | null;
    if (
      typeof event?.serveurId !== 'string' ||
      !RAISONS_SERVEUR.includes(event.raison as RaisonServeur) ||
      (event.cibleId !== null && typeof event.cibleId !== 'string') ||
      (event.tous !== undefined && typeof event.tous !== 'boolean') ||
      !Array.isArray(event.utilisateurIds) ||
      !event.utilisateurIds.every((id) => typeof id === 'string')
    ) {
      this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
      return;
    }
    const message = {
      serveurId: event.serveurId,
      raison: event.raison,
      cibleId: event.cibleId,
    };
    if (event.tous) {
      this.server.emit(SERVEUR_CHANNEL, message);
    } else {
      for (const userId of event.utilisateurIds) {
        this.server.to(`user:${userId}`).emit(SERVEUR_CHANNEL, message);
      }
    }
    this.rooms.oublierServeur(event.serveurId);
    this.revoquerAccesPerdus(event as EvenementServeur).catch(
      (erreur: unknown) => {
        this.logger.error(
          `Révocation des salons impossible: ${String(erreur)}`,
        );
      },
    );
  }

  private async revoquerAccesPerdus(event: EvenementServeur): Promise<void> {
    type SocketDistant = RemoteSocket<EvenementsVersClient, SocketData>;
    const tousLesSockets =
      event.tous && (event.raison === 'salons' || event.raison === 'supprime');
    const sockets = tousLesSockets
      ? ((await this.server.fetchSockets()) as unknown as SocketDistant[])
      : (
          await Promise.all(
            utilisateursARevalider(event).map(
              (userId) =>
                this.server
                  .in(`user:${userId}`)
                  .fetchSockets() as unknown as Promise<SocketDistant[]>,
            ),
          )
        ).flat();
    let gardesSansVerification = 0;
    for (const socket of sockets) {
      const userId = socket.data.userId;
      if (!userId) continue;
      const salons = socket.data.salons ?? {};
      for (const [salonId, serveurId] of Object.entries(salons)) {
        if (serveurId !== event.serveurId) continue;
        const peutLire =
          event.raison === 'supprime'
            ? false
            : await this.peutEncoreLire(salonId, {
                id: userId,
                role: socket.data.role ?? 'utilisateur',
              });
        if (peutLire === null) {
          gardesSansVerification += 1;
          continue;
        }
        if (peutLire) continue;
        socket.leave(`room:${salonId}`);
        delete salons[salonId];
        socket.emit('room-message.revoked', { roomId: salonId });
      }
    }
    if (gardesSansVerification > 0) {
      this.logger.warn(
        `Room-Service indisponible : ${gardesSansVerification} accès au serveur ${event.serveurId} gardé(s) sans revérification`,
      );
    }
  }

  private async peutEncoreLire(
    salonId: string,
    acteur: Acteur,
  ): Promise<boolean | null> {
    try {
      const acces = await this.rooms.verifierAcces(salonId, acteur);
      return acces.peutLire;
    } catch (erreur) {
      return erreur instanceof NotFoundException ? false : null;
    }
  }

  private broadcastPresenceEvent(payload: string): void {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      this.logger.warn(`Événement Redis invalide ignoré: ${payload}`);
      return;
    }

    const candidat = event as Partial<PresenceEvent> | null;
    if (
      typeof candidat?.userId !== 'string' ||
      (candidat.statut !== 'en-ligne' && candidat.statut !== 'hors-ligne')
    ) {
      this.logger.warn(`Payload Redis invalide ignoré: ${payload}`);
      return;
    }

    this.server
      .to(`presence:${candidat.userId}`)
      .to(`user:${candidat.userId}`)
      .emit(PRESENCE_CHANNEL, {
        userId: candidat.userId,
        statut: candidat.statut,
      });
  }

  private isPrivateMessageEvent(value: unknown): value is PrivateMessageEvent {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const event = value as Record<string, unknown>;

    return (
      typeof event.id === 'string' &&
      typeof event.senderId === 'string' &&
      typeof event.recipientId === 'string'
    );
  }

  private isRoomMessageEvent(value: unknown): value is RoomMessageEvent {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const event = value as Record<string, unknown>;

    return (
      typeof event.id === 'string' &&
      typeof event.roomId === 'string' &&
      typeof event.authorId === 'string'
    );
  }
}
