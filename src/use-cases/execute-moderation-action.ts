import { Api, TelegramClient } from "telegram";
import fs from "node:fs";
import path from "node:path";
import type { ModerationDecision } from "../types.js";
import type { Logger } from "../utils/logger.js";

export class ExecuteModerationActionUseCase {
  private readonly blockMessageHtml: string;

  constructor(private readonly logger: Logger) {
    this.blockMessageHtml = fs.readFileSync(path.resolve("assets/messages/message-block.html"), "utf8");
  }

  async execute(
    client: TelegramClient,
    input: { senderId: string; decision: ModerationDecision }
  ): Promise<void> {
    if (input.decision.action !== "block") return;

    try {
      const entity = await client.getInputEntity(input.senderId);
      await client.sendMessage(entity, { message: this.blockMessageHtml, parseMode: "html" });
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
