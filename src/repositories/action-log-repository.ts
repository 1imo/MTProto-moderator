import { ModerationDecision } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class ActionLogRepository {
  constructor(private readonly store: Store) {}

  async save(input: {
    senderId: string;
    chatId: string;
    decision: ModerationDecision;
  }): Promise<void> {
    await this.store.write(
      "action_logs.insert",
      input.senderId,
      input.chatId,
      input.decision,
      new Date().toISOString()
    );
  }
}
