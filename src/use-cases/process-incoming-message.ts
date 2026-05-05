import { ActionLogRepository } from "../repositories/action-log-repository.js";
import { MessageRepository } from "../repositories/message-repository.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import { ExperimentService, type Assignment } from "../services/experiment-service.js";
import { IncomingMessage, ModerationDecision } from "../types.js";
import { Analytics } from "../utils/analytics.js";
import { Logger } from "../utils/logger.js";
import { TelegramClient } from "telegram";
import { ActionQueueService } from "../bg-services/action-queue-service.js";
import { ExecuteModerationActionUseCase } from "./execute-moderation-action.js";

const WARNING_EXPERIMENT_ID = "warning_copy_2026_05";

export class ProcessIncomingMessageUseCase {
  constructor(
    private readonly messages: MessageRepository,
    private readonly actions: ActionLogRepository,
    private readonly executeModerationAction: ExecuteModerationActionUseCase,
    private readonly actionQueue: ActionQueueService,
    private readonly analytics: Analytics,
    private readonly logger: Logger,
    private readonly notifications: ClientNotificationService,
    private readonly experiments: ExperimentService
  ) {}

  async execute(client: TelegramClient, message: IncomingMessage): Promise<void> {
    await this.messages.save(message);
    const count = await this.messages.countBySender(message.senderId);
    const isFirstMessage = count === 1;
    const decision: ModerationDecision = isFirstMessage
      ? { action: "allow", confidence: 1, reason: "first_message_reply_sent" }
      : { action: "block", confidence: 1, reason: "follow_up_message_auto_block" };

    // Assignment is deterministic on senderId, so warning-side and block-side events
    // share an identical variant tag without any persisted state.
    const assignment = this.experiments.assign(WARNING_EXPERIMENT_ID, message.senderId);

    await this.actions.save({
      senderId: message.senderId,
      chatId: message.chatId,
      decision
    });

    this.analytics.trackEvent("moderation_decision", {
      senderId: message.senderId,
      chatId: message.chatId,
      action: decision.action,
      confidence: decision.confidence,
      experiment: assignment.experimentId,
      variant: assignment.variantId
    });

    if (isFirstMessage) {
      const firstMessageReplyHtml = await this.buildFirstMessageReplyHtml(client, assignment);
      await this.sendFirstMessageReply(
        client,
        message.chatId,
        firstMessageReplyHtml,
        assignment.mediaPath
      );
      this.analytics.trackEvent("first_message_reply_sent", {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: assignment.experimentId,
        variant: assignment.variantId,
        hasMedia: Boolean(assignment.mediaPath)
      });
      this.logger.info("first_message_reply_sent", {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: assignment.experimentId,
        variant: assignment.variantId,
        hasMedia: Boolean(assignment.mediaPath)
      });
      return;
    }

    this.actionQueue.enqueue(async () => {
      this.analytics.trackEvent("sender_block_queued", {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: assignment.experimentId,
        variant: assignment.variantId
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
        sentViaBot,
        experiment: assignment.experimentId,
        variant: assignment.variantId
      });
      if (!sentViaBot) {
        // Fallback: ensure the client still receives the block notice even if bot delivery fails.
        await this.sendReply(client, "me", noticeHtml);
      }
    });

    this.logger.info("sender_queued_for_block", {
      senderId: message.senderId,
      chatId: message.chatId,
      experiment: assignment.experimentId,
      variant: assignment.variantId
    });
  }

  private async sendReply(client: TelegramClient, chatId: string, html: string): Promise<void> {
    try {
      const entity = await client.getInputEntity(chatId);
      await client.sendMessage(entity, { message: html, parseMode: "html" });
    } catch (error) {
      this.logger.error("failed_to_send_reply", { chatId, error: String(error) });
    }
  }

  private async sendFirstMessageReply(
    client: TelegramClient,
    chatId: string,
    html: string,
    mediaPath: string | undefined
  ): Promise<void> {
    if (!mediaPath) {
      await this.sendReply(client, chatId, html);
      return;
    }
    try {
      const entity = await client.getInputEntity(chatId);
      await client.sendFile(entity, {
        file: mediaPath,
        caption: html,
        parseMode: "html"
      });
    } catch (error) {
      this.logger.error("failed_to_send_media_reply", {
        chatId,
        mediaPath,
        error: String(error)
      });
      // Fall back to text-only so the warning still lands even if the media upload fails.
      await this.sendReply(client, chatId, html);
    }
  }

  private async buildFirstMessageReplyHtml(
    client: TelegramClient,
    assignment: Assignment
  ): Promise<string> {
    try {
      const me = await client.getMe();
      const sessionUsername =
        typeof (me as { username?: unknown }).username === "string" && (me as { username?: string }).username
          ? `@${(me as { username: string }).username}`
          : "This account";
      return assignment.html.replaceAll(
        "{{SESSION_USERNAME}}",
        this.escapeHtml(sessionUsername)
      );
    } catch (error) {
      this.logger.warn("first_message_template_username_fallback", { error: String(error) });
      return assignment.html.replaceAll("{{SESSION_USERNAME}}", "This account");
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
