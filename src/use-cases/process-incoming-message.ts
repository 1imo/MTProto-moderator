import { ActionLogRepository } from "../repositories/action-log-repository.js";
import { MessageRepository } from "../repositories/message-repository.js";
import { ActionService } from "../services/action-service.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import { IncomingMessage, ModerationDecision } from "../types.js";
import { Analytics } from "../utils/analytics.js";
import { Logger } from "../utils/logger.js";
import { TelegramClient } from "telegram";
import { ActionQueueService } from "../bg-services/action-queue-service.js";

export class ProcessIncomingMessageUseCase {
  constructor(
    private readonly messages: MessageRepository,
    private readonly actions: ActionLogRepository,
    private readonly actionService: ActionService,
    private readonly actionQueue: ActionQueueService,
    private readonly analytics: Analytics,
    private readonly logger: Logger,
    private readonly firstMessageReplyText: string,
    private readonly notifications: ClientNotificationService
  ) {}

  async execute(client: TelegramClient, message: IncomingMessage): Promise<void> {
    this.messages.save(message);
    const count = this.messages.countBySender(message.senderId);
    const isFirstMessage = count === 1;
    const decision: ModerationDecision = isFirstMessage
      ? { action: "allow", confidence: 1, reason: "first_message_reply_sent" }
      : { action: "block", confidence: 1, reason: "follow_up_message_auto_block" };

    this.actions.save({
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
      this.logger.info("first_message_reply_sent", {
        senderId: message.senderId,
        chatId: message.chatId
      });
      return;
    }

    this.actionQueue.enqueue(async () => {
      await this.actionService.execute(client, {
        senderId: message.senderId,
        decision
      });
      const notice = `We just blocked ${message.senderId}. Please unblock them if you'd like any further interaction.`;
      const sentViaBot = await this.notifications.sendToClient(message.sessionId, notice);
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
