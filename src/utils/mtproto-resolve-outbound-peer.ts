import { Api, type TelegramClient } from "telegram";
import type { IncomingMessage } from "../types.js";
import type { Logger } from "./logger.js";

/**
 * Resolved peer for outbound messages / block (dialogs + Saved Messages fallback).
 */
export async function resolveOutboundPeer(
  client: TelegramClient,
  message: IncomingMessage,
  logger?: Logger
): Promise<Awaited<ReturnType<TelegramClient["getInputEntity"]>>> {
  const warn = (messageKey: string, payload: Record<string, unknown>) => {
    logger?.warn(messageKey, payload);
  };

  /**
   * In any private PeerUser DM, Telegram reports `senderId === chatId` (both identify the counterpart).
   * True "Saved Messages" / notes-to-self additionally has `chatId === sessionId` (dialog peer is the account).
   */
  const notesToSelf =
    message.senderId === message.chatId && message.chatId === message.sessionId;

  /**
   * Saved Messages: `getInputChat()` often resolves to a bare `PeerUser` that GramJS cannot use
   * for `sendMessage` / `sendFile` (missing access hash). Prefer `me` / `InputPeerSelf` before
   * any dialog-derived entity. Normal DMs never match `notesToSelf` because `chatId !== sessionId`.
   */
  if (notesToSelf) {
    try {
      return await client.getInputEntity("me");
    } catch (error) {
      warn("reply_entity_saved_messages_me_failed", {
        chatId: message.chatId,
        error: String(error)
      });
    }
    return new Api.InputPeerSelf();
  }

  if (message.mtprotoReplyEntity != null) {
    try {
      return await client.getInputEntity(message.mtprotoReplyEntity);
    } catch (error) {
      warn("reply_entity_from_getInputChat_failed", {
        chatId: message.chatId,
        error: String(error)
      });
    }
  }

  if (message.mtprotoPeer != null) {
    try {
      return await client.getInputEntity(message.mtprotoPeer);
    } catch (error) {
      warn("reply_entity_from_mtproto_peer_failed", {
        chatId: message.chatId,
        error: String(error)
      });
    }
  }

  return client.getInputEntity(message.chatId);
}
