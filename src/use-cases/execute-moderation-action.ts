import { Api, TelegramClient } from "telegram";
import type { ModerationDecision } from "../types.js";
import type { Logger } from "../utils/logger.js";

export class ExecuteModerationActionUseCase {
  constructor(private readonly logger: Logger) {}

  async execute(
    client: TelegramClient,
    input: {
      senderId: string;
      decision: ModerationDecision;
      blockMessageHtml?: string;
    }
  ): Promise<void> {
    if (input.decision.action !== "block") return;
    const body = input.blockMessageHtml?.trim();
    if (!body) {
      this.logger.error("missing_block_template", { senderId: input.senderId });
      return;
    }

    try {
      const entity = await client.getInputEntity(input.senderId);
      await client.sendMessage(entity, { message: body, parseMode: "html" });
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
