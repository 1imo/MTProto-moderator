import { IncomingMessage } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class MessageRepository {
  constructor(private readonly store: Store) {}

  async save(message: IncomingMessage): Promise<void> {
    await this.store.write(
      "messages.insert",
      message.senderId,
      message.chatId,
      message.date.toISOString()
    );
  }

  async countBySender(senderId: string, collapseWindowSeconds = 0): Promise<number> {
    return this.store.read<number>("messages.count_by_sender", 0, senderId, collapseWindowSeconds);
  }

  /** Messages from sender within the collapse window ending at `at` (inclusive). */
  async countInMessagingInstance(
    senderId: string,
    at: Date,
    collapseWindowSeconds: number
  ): Promise<number> {
    return this.store.read<number>(
      "messages.count_in_instance",
      0,
      senderId,
      at.toISOString(),
      collapseWindowSeconds
    );
  }
}
