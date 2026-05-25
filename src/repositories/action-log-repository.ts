import { ModerationDecision } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class ActionLogRepository {
  constructor(private readonly store: Store) {}

  async hasPriorBlock(senderId: string, chatId: string): Promise<boolean> {
    return this.store.read<boolean>("action_logs.has_prior_block", 0, senderId, chatId);
  }

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

  saveDeferred(input: {
    senderId: string;
    chatId: string;
    decision: ModerationDecision;
  }): void {
    this.store.writeDeferred(
      "action_logs.insert",
      input.senderId,
      input.chatId,
      input.decision,
      new Date().toISOString()
    );
  }
}
