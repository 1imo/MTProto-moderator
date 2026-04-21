import { ActionLogRepository } from "../repositories/action-log-repository.js";
import { MessageRepository } from "../repositories/message-repository.js";
import { ActionService } from "../services/action-service.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import fs from "node:fs";
import path from "node:path";
import { IncomingMessage, ModerationDecision } from "../types.js";
import { Analytics } from "../utils/analytics.js";
import { Logger } from "../utils/logger.js";
import { TelegramClient } from "telegram";
import { ActionQueueService } from "../bg-services/action-queue-service.js";

export class ProcessIncomingMessageUseCase {
  private readonly firstMessageReplyText: string;

  constructor(
    private readonly messages: MessageRepository,
    private readonly actions: ActionLogRepository,
    private readonly actionService: ActionService,
    private readonly actionQueue: ActionQueueService,
    private readonly analytics: Analytics,
    private readonly logger: Logger,
    private readonly notifications: ClientNotificationService
  ) {
    const messageHtml = fs.readFileSync(path.resolve("assets/messages/message.html"), "utf8");
    this.firstMessageReplyText = messageHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  async execute(client: TelegramClient, message: IncomingMessage): Promise<void> {
    await this.messages.save(message);
    const count = await this.messages.countBySender(message.senderId);
    const isFirstMessage = count === 1;
    const decision: ModerationDecision = isFirstMessage
      ? { action: "allow", confidence: 1, reason: "first_message_reply_sent" }
      : { action: "block", confidence: 1, reason: "follow_up_message_auto_block" };

    await this.actions.save({
      senderId: message.senderId,
      chatId: message.chatId,
      decision
    });

    this.analytics.trackEvent("moderation_decision", {
      senderId: message.senderId,
      chatId: message.chatId,
      action: decision.action,
      confidence: decision.confidence
    });

    if (isFirstMessage) {
      await this.sendReply(client, message.chatId, this.firstMessageReplyText);
      this.analytics.trackEvent("first_message_reply_sent", {
        senderId: message.senderId,
        chatId: message.chatId
      });
      this.logger.info("first_message_reply_sent", {
        senderId: message.senderId,
        chatId: message.chatId
      });
      return;
    }

    this.actionQueue.enqueue(async () => {
      this.analytics.trackEvent("sender_block_queued", {
        senderId: message.senderId,
        chatId: message.chatId
      });
      await this.actionService.execute(client, {
        senderId: message.senderId,
        decision
      });
      const notice = `We just blocked ${message.senderId}. Please unblock them if you'd like any further interaction.`;
      const sentViaBot = await this.notifications.sendToClient(message.sessionId, notice);
      this.analytics.trackEvent("block_notice_sent", {
        senderId: message.senderId,
        sessionId: message.sessionId,
        sentViaBot
      });
      if (!sentViaBot) {
        // Fallback: ensure the client still receives the block notice even if bot delivery fails.
        await this.sendReply(client, "me", notice);
      }
    });

    this.logger.info("sender_queued_for_block", { senderId: message.senderId, chatId: message.chatId });
  }

  private async sendReply(client: TelegramClient, chatId: string, text: string): Promise<void> {
    try {
      const entity = await client.getInputEntity(chatId);
      await client.sendMessage(entity, { message: text });
    } catch (error) {
      this.logger.error("failed_to_send_reply", { chatId, error: String(error) });
    }
  }
}
