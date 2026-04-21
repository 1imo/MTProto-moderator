import { Api, TelegramClient } from "telegram";
import { ModerationDecision } from "../types.js";
import { Logger } from "../utils/logger.js";

export class ActionService {
  constructor(private readonly logger: Logger) {}

  async execute(
    client: TelegramClient,
    input: { senderId: string; decision: ModerationDecision }
  ): Promise<void> {
    if (input.decision.action !== "block") return;

    try {
      const entity = await client.getInputEntity(input.senderId);
      await client.invoke(
        new Api.contacts.Block({
          id: entity
        })
      );
      this.logger.info("sender_blocked", { senderId: input.senderId });
    } catch (error) {
      this.logger.error("failed_to_block_sender", {
        senderId: input.senderId,
        error: String(error)
      });
    }
  }
}
