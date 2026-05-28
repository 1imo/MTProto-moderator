import type { Context } from "telegraf";
import type { MtprotoListenerService } from "../bg-services/mtproto-listener-service.js";
import type { SessionModerationToggleMiddleware } from "../middleware/session-moderation-toggle-middleware.js";
import type { ProcessIncomingMessageUseCase } from "../use-cases/process-incoming-message.js";
import type { Logger } from "../utils/logger.js";

/**
 * Bot API path for messages tied to a user's account via Business / Chat Automation style links.
 * Telegram delivers `business_message` or `message` with `business_connection_id`; we resolve the
 * owning user, reuse their active MTProto `TelegramClient`, and run the same moderation pipeline.
 */
type AutomationMessageShape = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
  business_connection_id?: string;
};

function extractAutomationMessage(update: Record<string, unknown>): AutomationMessageShape | undefined {
  const bm = update.business_message as AutomationMessageShape | undefined;
  if (bm && typeof bm.business_connection_id === "string" && bm.business_connection_id.length > 0) {
    return bm;
  }
  const m = update.message as AutomationMessageShape | undefined;
  if (m && typeof m.business_connection_id === "string" && m.business_connection_id.length > 0) {
    return m;
  }
  return undefined;
}

export class ChatAutomationController {
  constructor(
    private readonly processIncoming: ProcessIncomingMessageUseCase,
    private readonly sessionModeration: SessionModerationToggleMiddleware,
    private readonly mtprotoService: MtprotoListenerService,
    private readonly logger: Logger
  ) {}

  /**
   * @returns true if this update was handled here (do not run normal bot text/onboarding handlers)
   */
  async tryHandle(ctx: Context): Promise<boolean> {
    const msg = extractAutomationMessage(ctx.update as unknown as Record<string, unknown>);
    if (!msg) return false;

    if (msg.chat.type && msg.chat.type !== "private") return false;
    const from = msg.from;
    if (!from || from.is_bot) return false;

    const bcId = msg.business_connection_id;
    if (!bcId) return false;

    let ownerUserId: string;
    try {
      const tg = ctx.telegram as unknown as {
        callApi<M extends string, P extends object>(
          method: M,
          payload: P
        ): Promise<{ user?: { id: number } }>;
      };
      const conn = await tg.callApi("getBusinessConnection", { business_connection_id: bcId });
      const id = conn.user?.id;
      if (typeof id !== "number") {
        this.logger.warn("chat_automation_connection_missing_user", { businessConnectionId: bcId });
        return true;
      }
      ownerUserId = String(id);
    } catch (error) {
      this.logger.error("chat_automation_get_connection_failed", {
        businessConnectionId: bcId,
        error: String(error)
      });
      return true;
    }

    const enabled = await this.sessionModeration.isEnabled(ownerUserId);
    if (!enabled) return true;

    const client = this.mtprotoService.getClient(ownerUserId);
    if (!client) {
      this.logger.warn("chat_automation_no_mtproto_session", {
        ownerUserId,
        hint: "User must complete onboarding so an MTProto client is connected for actions"
      });
      return true;
    }

    const text =
      typeof msg.text === "string" && msg.text.trim().length > 0 ? msg.text : "[non-text message]";
    const senderUsername =
      typeof from.username === "string" && from.username.length > 0 ? from.username : undefined;

    try {
      await this.processIncoming.execute(client, {
        sessionId: ownerUserId,
        chatId: String(msg.chat.id),
        senderId: String(from.id),
        senderUsername,
        senderIsBot: Boolean(from.is_bot),
        text,
        date: new Date(),
        telegramMessageId: typeof msg.message_id === "number" ? msg.message_id : undefined,
        source: "bot_api_automation"
      });
    } catch (error) {
      this.logger.error("chat_automation_process_failed", { ownerUserId, error: String(error) });
    }
    return true;
  }
}
