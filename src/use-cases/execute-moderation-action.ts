import { Api, TelegramClient } from "telegram";
import type { IncomingMessage, ModerationDecision } from "../types.js";
import { resolveOutboundPeer } from "../utils/mtproto-resolve-outbound-peer.js";
import type { Logger } from "../utils/logger.js";

export class ExecuteModerationActionUseCase {
  constructor(private readonly logger: Logger) {}

  async execute(
    client: TelegramClient,
    input: {
      senderId: string;
      decision: ModerationDecision;
      blockMessageHtml?: string;
      /** MTProto path: peer resolution matches warning replies (Saved Messages / min peers). */
      moderationIncoming?: IncomingMessage;
    }
  ): Promise<void> {
    if (input.decision.action !== "block") return;
    const body = input.blockMessageHtml?.trim();
    if (!body) {
      this.logger.error("missing_block_template", { senderId: input.senderId });
      return;
    }

    let entity: Awaited<ReturnType<TelegramClient["getInputEntity"]>>;
    try {
      entity =
        input.moderationIncoming != null
          ? await resolveOutboundPeer(client, input.moderationIncoming, this.logger)
          : await client.getInputEntity(input.senderId);
    } catch (error) {
      this.logger.error("failed_to_resolve_block_peer", {
        senderId: input.senderId,
        error: String(error)
      });
      return;
    }

    const replyToMsgId =
      typeof input.moderationIncoming?.telegramMessageId === "number" &&
      input.moderationIncoming.telegramMessageId > 0
        ? input.moderationIncoming.telegramMessageId
        : undefined;

    try {
      const sent = await client.sendMessage(entity, {
        message: body,
        parseMode: "html",
        ...(replyToMsgId != null ? { replyTo: replyToMsgId } : {})
      });
      const sentId = sent instanceof Api.Message ? sent.id : undefined;
      this.logger.info("block_notice_dm_sent", {
        senderId: input.senderId,
        chatId: input.moderationIncoming?.chatId,
        telegramSentMessageId: sentId,
        replyToMessageId: replyToMsgId
      });
    } catch (error) {
      this.logger.error("failed_to_send_block_dm", {
        senderId: input.senderId,
        error: String(error)
      });
      return;
    }

    if (entity instanceof Api.InputPeerSelf) {
      this.logger.info("contacts_block_skipped_self_peer", { senderId: input.senderId });
      return;
    }

    try {
      await client.invoke(
        new Api.contacts.Block({
          id: entity
        })
      );
      this.logger.info("sender_blocked", { senderId: input.senderId });
    } catch (error) {
      this.logger.error("failed_contacts_block", {
        senderId: input.senderId,
        error: String(error)
      });
    }
  }
}
