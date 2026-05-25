import type { TelegramClient } from "telegram";

export type ModerationAction = "allow" | "ignore" | "block";

export interface ModerationDecision {
  action: ModerationAction;
  confidence: number;
  reason: string;
}

export type ModerationInboundSource = "mtproto" | "bot_api_automation";

/** Argument GramJS accepts for `getInputEntity` / send targets */
export type MtprotoEntityLike = Parameters<TelegramClient["getInputEntity"]>[0];

/** Narrow TL peer reference — optional so Bot API path stays plain ids */
export type MtprotoPeerLike = import("telegram").Api.TypePeer;

export interface IncomingMessage {
  sessionId: string;
  chatId: string;
  senderId: string;
  senderUsername?: string;
  text: string;
  date: Date;
  /** Telegram server message id within this chat; enables cross-transport dedupe when both are set */
  telegramMessageId?: number;
  source?: ModerationInboundSource;
  /**
   * From CustomMessage.getInputChat(): dialog-backed InputPeer (access hash). Strongest resolution.
   */
  mtprotoReplyEntity?: MtprotoEntityLike;
  /**
   * Original MTProto `peerId` for this chat; fallback when entity cache is cold.
   */
  mtprotoPeer?: MtprotoPeerLike;
}

export type SessionRecord = {
  userId: string;
  sessionString: string;
  active: boolean;
};
