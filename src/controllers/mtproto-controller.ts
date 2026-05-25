import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import type { TelegramClient } from "telegram";
import type { ProcessIncomingMessageUseCase } from "../use-cases/process-incoming-message.js";
import type { Logger } from "../utils/logger.js";

export class MtprotoController {
  constructor(
    private readonly useCase: ProcessIncomingMessageUseCase,
    private readonly logger: Logger
  ) {}

  async handleNewMessage(client: TelegramClient, sessionId: string, event: NewMessageEvent): Promise<void> {
    try {
      const rawMessageText = event.message?.message;
      const messageText =
        typeof rawMessageText === "string" && rawMessageText.trim().length > 0
          ? rawMessageText
          : "[non-text message]";
      if (event.message.out) return;
      if (event.message.peerId?.className !== "PeerUser") return;

      // Prefer entities bundled with the update — avoid getSender()/getInputChat() network fallbacks.
      const sender = event.message.sender;
      const senderUsername =
        typeof (sender as { username?: unknown } | undefined)?.username === "string"
          ? String((sender as { username: string }).username)
          : "";
      const isBotSender =
        Boolean(event.message.viaBotId) ||
        (sender as { bot?: unknown } | undefined)?.bot === true ||
        senderUsername.toLowerCase().endsWith("bot");
      if (isBotSender) return;

      const senderId = event.message.senderId?.toString();
      const chatId = event.message.chatId?.toString();
      if (!senderId || !chatId) return;

      const telegramMessageId =
        typeof event.message.id === "number" && event.message.id > 0 ? event.message.id : undefined;

      const mtprotoReplyEntity = event.message.inputChat ?? undefined;

      await this.useCase.execute(client, {
        sessionId,
        chatId,
        senderId,
        senderUsername,
        text: messageText,
        date: new Date(),
        telegramMessageId,
        source: "mtproto",
        mtprotoReplyEntity: mtprotoReplyEntity ?? undefined,
        mtprotoPeer: event.message.peerId
      });
    } catch (error) {
      this.logger.error("mtproto_event_handler_failed", { error: String(error) });
    }
  }
}
