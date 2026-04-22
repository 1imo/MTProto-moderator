import { ActionLogRepository } from "../repositories/action-log-repository.js";
import { MessageRepository } from "../repositories/message-repository.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import fs from "node:fs";
import path from "node:path";
import { IncomingMessage, ModerationDecision } from "../types.js";
import { Analytics } from "../utils/analytics.js";
import { Logger } from "../utils/logger.js";
import { TelegramClient } from "telegram";
import { ActionQueueService } from "../bg-services/action-queue-service.js";
import { ExecuteModerationActionUseCase } from "./execute-moderation-action.js";

export class ProcessIncomingMessageUseCase {
  private readonly firstMessageReplyHtmlTemplate: string;

  constructor(
    private readonly messages: MessageRepository,
    private readonly actions: ActionLogRepository,
    private readonly executeModerationAction: ExecuteModerationActionUseCase,
    private readonly actionQueue: ActionQueueService,
    private readonly analytics: Analytics,
    private readonly logger: Logger,
    private readonly notifications: ClientNotificationService
  ) {
    this.firstMessageReplyHtmlTemplate = fs.readFileSync(
      path.resolve("assets/messages/message-warning.html"),
      "utf8"
    );
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
      const firstMessageReplyHtml = await this.buildFirstMessageReplyHtml(client);
      await this.sendReply(client, message.chatId, firstMessageReplyHtml);
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
      await this.executeModerationAction.execute(client, {
        senderId: message.senderId,
        decision
      });
      const senderRef = message.senderUsername?.trim()
        ? `@${this.escapeHtml(message.senderUsername.trim())}`
        : `User ID ${this.escapeHtml(message.senderId)}`;
      const noticeHtml = `We just blocked ${senderRef}. Please unblock them if you'd like any further interaction.`;
      const sentViaBot = await this.notifications.sendHTML(message.sessionId, noticeHtml);
      this.analytics.trackEvent("block_notice_sent", {
        senderId: message.senderId,
        sessionId: message.sessionId,
        sentViaBot
      });
      if (!sentViaBot) {
        // Fallback: ensure the client still receives the block notice even if bot delivery fails.
        await this.sendReply(client, "me", noticeHtml);
      }
    });

    this.logger.info("sender_queued_for_block", { senderId: message.senderId, chatId: message.chatId });
  }

  private async sendReply(client: TelegramClient, chatId: string, html: string): Promise<void> {
    try {
      const entity = await client.getInputEntity(chatId);
      await client.sendMessage(entity, { message: html, parseMode: "html" });
    } catch (error) {
      this.logger.error("failed_to_send_reply", { chatId, error: String(error) });
    }
  }

  private async buildFirstMessageReplyHtml(client: TelegramClient): Promise<string> {
    try {
      const me = await client.getMe();
      const sessionUsername =
        typeof (me as { username?: unknown }).username === "string" && (me as { username?: string }).username
          ? `@${(me as { username: string }).username}`
          : "This account";
      return this.firstMessageReplyHtmlTemplate.replaceAll(
        "{{SESSION_USERNAME}}",
        this.escapeHtml(sessionUsername)
      );
    } catch (error) {
      this.logger.warn("first_message_template_username_fallback", { error: String(error) });
      return this.firstMessageReplyHtmlTemplate.replaceAll("{{SESSION_USERNAME}}", "This account");
    }
  }

  private escapeHtml(input: string): string {
    return input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
}
