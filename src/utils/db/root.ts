import { Database } from "./database.js";
import { DeferredWriteQueue } from "./queue.js";
import type { ModerationDecision, SessionRecord } from "../../types.js";

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

export class Store {
  private readonly backing: Database;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly writeQueue = new DeferredWriteQueue();

  /** Write-through session cache (userId → record or null if known absent). */
  private readonly sessionByUserId = new Map<string, SessionRecord | null>();
  private listActiveSnapshot: SessionRecord[] | undefined;

  constructor() {
    this.backing = new Database();
  }

  async close(): Promise<void> {
    await this.backing.close();
  }

  async write(query: string, ...args: unknown[]): Promise<void> {
    await this.persist(query, args, true);
  }

  /** Enqueue persistence without blocking the caller (used for non-critical audit writes). */
  writeDeferred(query: string, ...args: unknown[]): void {
    void this.persist(query, args, false);
  }

  private async persist(query: string, args: unknown[], wait: boolean): Promise<void> {
    const run = async () => {
      switch (query) {
        case "messages.insert": {
          const [senderId, chatId, createdAt] = args as [string, string, string];
          await this.backing.query(
            `INSERT INTO messages(sender_id, chat_id, created_at) VALUES ($1, $2, $3::timestamptz)`,
            [senderId, chatId, createdAt]
          );
          this.invalidateQueryCache();
          return;
        }
        case "action_logs.insert": {
          const [senderId, chatId, decision, createdAt] = args as [
            string,
            string,
            ModerationDecision,
            string
          ];
          await this.backing.query(
            `INSERT INTO action_logs(sender_id, chat_id, decision_json, created_at)
             VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
            [senderId, chatId, JSON.stringify(decision), createdAt]
          );
          this.invalidateQueryCache();
          return;
        }
        case "sessions.upsert_active": {
          const [userId, sessionString, now] = args as [string, string, string];
          await this.backing.query(
            `INSERT INTO sessions(user_id, session_string, active, created_at, updated_at)
             VALUES ($1, $2, TRUE, $3::timestamptz, $3::timestamptz)
             ON CONFLICT(user_id)
             DO UPDATE SET session_string = EXCLUDED.session_string, active = TRUE, updated_at = EXCLUDED.updated_at`,
            [userId, sessionString, now]
          );
          return;
        }
        case "sessions.set_active": {
          const [userId, active, now] = args as [string, boolean, string];
          await this.backing.query(
            `UPDATE sessions SET active = $2, updated_at = $3::timestamptz WHERE user_id = $1`,
            [userId, active, now]
          );
          return;
        }
        case "analytics.insert": {
          const [event, props, createdAt] = args as [string, Record<string, unknown>, string];
          await this.backing.query(
            `INSERT INTO analytics_events(event, props_json, created_at)
             VALUES ($1, $2::jsonb, $3::timestamptz)`,
            [event, JSON.stringify(props), createdAt]
          );
          this.invalidateQueryCache();
          return;
        }
        case "users.upsert": {
          const [telegramId, username, firstName, lastName, now] = args as [
            number,
            string,
            string,
            string,
            string
          ];
          await this.backing.query(
            `INSERT INTO users(telegram_id, username, first_name, last_name, last_seen_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz)
             ON CONFLICT(telegram_id)
             DO UPDATE SET
               username = CASE WHEN btrim(EXCLUDED.username) = '' THEN users.username ELSE EXCLUDED.username END,
               first_name = CASE WHEN btrim(EXCLUDED.first_name) = '' THEN users.first_name ELSE EXCLUDED.first_name END,
               last_name = CASE WHEN btrim(EXCLUDED.last_name) = '' THEN users.last_name ELSE EXCLUDED.last_name END,
               last_seen_at = EXCLUDED.last_seen_at,
               updated_at = NOW()`,
            [telegramId, username, firstName, lastName, now]
          );
          this.invalidateQueryCache();
          return;
        }
        case "group_chats.upsert_if_needed": {
          const [chatId, now] = args as [number, string];
          if (chatId >= 0) return;
          await this.backing.query(
            `INSERT INTO group_chats(telegram_id, first_seen_at, last_seen_at, created_at, updated_at)
             VALUES ($1, $2::timestamptz, $2::timestamptz, $2::timestamptz, $2::timestamptz)
             ON CONFLICT(telegram_id)
             DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, updated_at = NOW()`,
            [chatId, now]
          );
          this.invalidateQueryCache();
          return;
        }
        default:
          throw new Error(`unknown write query: ${query}`);
      }
    };

    if (query === "sessions.upsert_active") {
      const [userId, sessionString] = args as [string, string, string];
      this.putSessionCache({
        userId,
        sessionString,
        active: true
      });
    } else if (query === "sessions.set_active") {
      const [userId, active] = args as [string, boolean, string];
      const existing = this.sessionByUserId.get(userId);
      if (existing) {
        this.putSessionCache({ ...existing, active });
      } else {
        this.putSessionCache({
          userId,
          sessionString: "",
          active
        });
      }
    }

    if (wait) {
      await this.writeQueue.enqueue(query, run);
      return;
    }

    this.writeQueue.enqueueFireAndForget(query, run);
  }

  async read<T>(query: string, cacheLifetimeMs = 0, ...args: unknown[]): Promise<T> {
    if (query === "sessions.find_by_user_id") {
      const [userId] = args as [string];
      return this.readSessionByUserId(userId) as Promise<T>;
    }

    if (query === "sessions.list_active") {
      return this.readSessionsListActive() as Promise<T>;
    }

    const now = Date.now();
    const cacheKey = this.buildCacheKey(query, args);
    if (cacheLifetimeMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && now < cached.expiresAt) {
        return cached.value as T;
      }
    }

    const result = await this.executeRead<T>(query, args);
    if (cacheLifetimeMs > 0) {
      this.cache.set(cacheKey, {
        expiresAt: now + cacheLifetimeMs,
        value: result
      });
    }
    return result;
  }

  private async readSessionByUserId(userId: string): Promise<SessionRecord | null> {
    if (this.sessionByUserId.has(userId)) {
      return this.sessionByUserId.get(userId) ?? null;
    }
    const record = await this.executeRead<SessionRecord | null>("sessions.find_by_user_id", [userId]);
    this.sessionByUserId.set(userId, record);
    return record;
  }

  private async readSessionsListActive(): Promise<SessionRecord[]> {
    if (this.listActiveSnapshot) {
      return this.listActiveSnapshot;
    }
    const rows = await this.executeRead<SessionRecord[]>("sessions.list_active", []);
    this.listActiveSnapshot = rows;
    return rows;
  }

  private putSessionCache(record: SessionRecord): void {
    this.sessionByUserId.set(record.userId, record);
    this.listActiveSnapshot = undefined;
  }

  private async executeRead<T>(query: string, args: unknown[]): Promise<T> {
    switch (query) {
      case "messages.count_by_sender": {
        const [senderId, collapseWindowSeconds = 0] = args as [string, number?];
        if (collapseWindowSeconds <= 0) {
          const rows = await this.backing.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM messages WHERE sender_id = $1`,
            [senderId]
          );
          return Number(rows[0]?.n ?? 0) as T;
        }

        const rows = await this.backing.query<{ n: string }>(
          `WITH ordered AS (
             SELECT
               created_at,
               LAG(created_at) OVER (ORDER BY created_at) AS previous_created_at
             FROM messages
             WHERE sender_id = $1
           )
           SELECT COUNT(*)::text AS n
           FROM ordered
           WHERE previous_created_at IS NULL
              OR created_at - previous_created_at > make_interval(secs => $2)`,
          [senderId, collapseWindowSeconds]
        );
        return Number(rows[0]?.n ?? 0) as T;
      }
      case "messages.count_in_instance": {
        const [senderId, atIso, collapseWindowSeconds] = args as [string, string, number];
        const rows = await this.backing.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
           FROM messages
           WHERE sender_id = $1
             AND created_at <= $2::timestamptz
             AND created_at > $2::timestamptz - make_interval(secs => $3)`,
          [senderId, atIso, collapseWindowSeconds]
        );
        return Number(rows[0]?.n ?? 0) as T;
      }
      case "action_logs.has_prior_block": {
        const [senderId, chatId] = args as [string, string];
        const rows = await this.backing.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM action_logs
             WHERE sender_id = $1
               AND chat_id = $2
               AND decision_json->>'action' = 'block'
           ) AS exists`,
          [senderId, chatId]
        );
        return Boolean(rows[0]?.exists) as T;
      }
      case "sessions.list_active": {
        const rows = await this.backing.query<{
          user_id: string;
          session_string: string;
          active: boolean;
        }>(`SELECT user_id, session_string, active FROM sessions WHERE active = TRUE`);
        return rows.map((row) => ({
          userId: row.user_id,
          sessionString: row.session_string,
          active: row.active
        })) as T;
      }
      case "sessions.find_by_user_id": {
        const [userId] = args as [string];
        const rows = await this.backing.query<{
          user_id: string;
          session_string: string;
          active: boolean;
        }>(`SELECT user_id, session_string, active FROM sessions WHERE user_id = $1 LIMIT 1`, [userId]);
        const row = rows[0];
        if (!row) return null as T;
        return {
          userId: row.user_id,
          sessionString: row.session_string,
          active: row.active
        } as T;
      }
      default:
        throw new Error(`unknown read query: ${query}`);
    }
  }

  private buildCacheKey(query: string, args: unknown[]): string {
    return `${query}:${JSON.stringify(args)}`;
  }

  private invalidateQueryCache(): void {
    this.cache.clear();
  }
}
