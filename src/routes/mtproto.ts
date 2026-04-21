import { NewMessage, NewMessageEvent } from "telegram/events/NewMessage.js";
import type { TelegramClient } from "telegram";
import type { MtprotoController } from "../controllers/mtproto-controller.js";

export class MtprotoRoutes {
  constructor(private readonly controller: MtprotoController) {}

  bind(client: TelegramClient, sessionId: string): void {
    client.addEventHandler(async (event: NewMessageEvent) => {
      await this.controller.handleNewMessage(client, sessionId, event);
    }, new NewMessage({}));
  }
}
