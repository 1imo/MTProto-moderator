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

const LEVEL1_WARNING_EXPERIMENT_ID = "level1_message_warning";
const LEVEL2_WARNING_FINAL_EXPERIMENT_ID = "level2_message_warning_final";
const LEVEL3_BLOCK_EXPERIMENT_ID = "level3_messages_block";

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
    if (await this.actions.hasPriorBlock(message.senderId, message.chatId)) {
      const decision: ModerationDecision = {
        action: "ignore",
        confidence: 1,
        reason: "prior_block_in_chat_skip"
      };
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
        reason: decision.reason,
        tier: "skipped_prior_block"
      });
      this.logger.info("moderation_skipped_prior_block", {
        senderId: message.senderId,
        chatId: message.chatId
      });
      return;
    }

    const count = await this.messages.countBySender(message.senderId);
    const tier: "first_warning" | "second_warning" | "block" =
      count === 1 ? "first_warning" : count === 2 ? "second_warning" : "block";

    const tierAssignment =
      tier === "first_warning"
        ? this.experiments.assignModerationTier(LEVEL1_WARNING_EXPERIMENT_ID, message.senderId)
        : tier === "second_warning"
          ? this.experiments.assignModerationTier(LEVEL2_WARNING_FINAL_EXPERIMENT_ID, message.senderId)
          : this.experiments.assignModerationTier(LEVEL3_BLOCK_EXPERIMENT_ID, message.senderId);

    const decision: ModerationDecision =
      tier === "block"
        ? { action: "block", confidence: 1, reason: "third_or_later_message_auto_block" }
        : tier === "second_warning"
          ? { action: "allow", confidence: 1, reason: "second_message_warning_sent" }
          : { action: "allow", confidence: 1, reason: "first_message_reply_sent" };

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
      experiment: tierAssignment.experimentId,
      variant: tierAssignment.variantId,
      tier
    });

    if (tier === "first_warning" || tier === "second_warning") {
      const replyHtml = await this.buildReplyHtml(client, tierAssignment);
      await this.sendFirstMessageReply(
        client,
        message.chatId,
        replyHtml,
        tierAssignment.mediaPath
      );
      const eventName =
        tier === "first_warning" ? "first_message_reply_sent" : "second_message_warning_sent";
      this.analytics.trackEvent(eventName, {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: tierAssignment.experimentId,
        variant: tierAssignment.variantId,
        hasMedia: Boolean(tierAssignment.mediaPath)
      });
      this.logger.info(eventName, {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: tierAssignment.experimentId,
        variant: tierAssignment.variantId,
        hasMedia: Boolean(tierAssignment.mediaPath)
      });
      return;
    }

    this.actionQueue.enqueue(async () => {
      this.analytics.trackEvent("sender_block_queued", {
        senderId: message.senderId,
        chatId: message.chatId,
        experiment: tierAssignment.experimentId,
        variant: tierAssignment.variantId
      });
      const blockMessageHtml = await this.buildReplyHtml(client, tierAssignment);
      await this.executeModerationAction.execute(client, {
        senderId: message.senderId,
        decision,
        blockMessageHtml
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
        experiment: tierAssignment.experimentId,
        variant: tierAssignment.variantId
      });
      if (!sentViaBot) {
        await this.sendReply(client, "me", noticeHtml);
      }
    });

    this.logger.info("sender_queued_for_block", {
      senderId: message.senderId,
      chatId: message.chatId,
      experiment: tierAssignment.experimentId,
      variant: tierAssignment.variantId
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
      await this.sendReply(client, chatId, html);
    }
  }

  private async buildReplyHtml(client: TelegramClient, assignment: Assignment): Promise<string> {
    return this.substituteSessionUsernameHtml(client, assignment.html);
  }

  private async substituteSessionUsernameHtml(client: TelegramClient, html: string): Promise<string> {
    try {
      const me = await client.getMe();
      const sessionUsername =
        typeof (me as { username?: unknown }).username === "string" && (me as { username?: string }).username
          ? `@${(me as { username: string }).username}`
          : "This account";
      return html.replaceAll("{{SESSION_USERNAME}}", this.escapeHtml(sessionUsername));
    } catch (error) {
      this.logger.warn("template_username_fallback", { error: String(error) });
      return html.replaceAll("{{SESSION_USERNAME}}", "This account");
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
