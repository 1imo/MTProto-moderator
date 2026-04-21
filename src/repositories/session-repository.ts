import type { SessionRecord } from "../types.js";
import type { Store } from "../utils/db/root.js";

export class SessionRepository {
  constructor(private readonly store: Store) {}

  listActive(): SessionRecord[] {
    return this.store.read<SessionRecord[]>("sessions.list_active", 3000);
  }

  findByUserId(userId: string): SessionRecord | null {
    return this.store.read<SessionRecord | null>("sessions.find_by_user_id", 0, userId);
  }

  upsertActive(userId: string, sessionString: string): void {
    this.store.write("sessions.upsert_active", userId, sessionString, new Date().toISOString());
  }
}
