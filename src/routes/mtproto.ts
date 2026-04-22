import { NewMessage, NewMessageEvent } from "telegram/events/NewMessage.js";
import type { TelegramClient } from "telegram";
import type { MtprotoController } from "../controllers/mtproto-controller.js";
import type { SessionModerationToggleMiddleware } from "../middleware/session-moderation-toggle-middleware.js";

export class MtprotoRoutes {
  constructor(
    private readonly controller: MtprotoController,
    private readonly sessionModerationToggle: SessionModerationToggleMiddleware
  ) {}

  bind(client: TelegramClient, sessionId: string): void {
    client.addEventHandler(async (event: NewMessageEvent) => {
      const enabled = await this.sessionModerationToggle.isEnabled(sessionId);
      if (!enabled) return;
      await this.controller.handleNewMessage(client, sessionId, event);
    }, new NewMessage({}));
  }
}
