import { PrivateMessage } from '@prisma/client';

export type ConversationSummary = {
  otherUserId: string;
  lastMessage: PrivateMessage;
  unreadCount: number;
};
