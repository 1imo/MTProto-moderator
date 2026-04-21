import { TelegramClient } from "telegram";
import { ActionService } from "../services/action-service.js";
import { ModerationDecision } from "../types.js";

export async function executeModerationAction(
  actionService: ActionService,
  client: TelegramClient,
  senderId: string,
  decision: ModerationDecision
): Promise<void> {
  await actionService.execute(client, { senderId, decision });
}
