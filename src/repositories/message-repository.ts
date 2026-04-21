import { IncomingMessage } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class MessageRepository {
  constructor(private readonly store: Store) {}

  save(message: IncomingMessage): void {
    this.store.write(
      "messages.insert",
      message.senderId,
      message.chatId,
      message.date.toISOString()
    );
  }

  countBySender(senderId: string): number {
    return this.store.read<number>("messages.count_by_sender", 0, senderId);
  }
}
