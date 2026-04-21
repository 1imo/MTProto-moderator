import { env } from "../env.js";
import { Database } from "./database.js";
import type { ModerationDecision } from "../../types.js";

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

export class Store {
  private readonly backing: Database;
  private readonly cache = new Map<string, CacheEntry>();

  constructor() {
    this.backing = new Database(env, () => {
      this.invalidateCache();
    });
  }

  write(query: string, ...args: unknown[]): void {
    switch (query) {
      case "messages.insert": {
        const [senderId, chatId, createdAt] = args as [string, string, string];
        this.backing.messages.push({ senderId, chatId, createdAt });
        this.backing.persist();
        return;
      }
      case "action_logs.insert": {
        const [senderId, chatId, decision, createdAt] = args as [
          string,
          string,
          ModerationDecision,
          string
        ];
        this.backing.actionLogs.push({
          senderId,
          chatId,
          decision,
          createdAt
        });
        this.backing.persist();
        return;
      }
      case "sessions.upsert_active": {
        const [userId, sessionString, now] = args as [string, string, string];
        const existing = this.backing.sessions.find((s) => s.userId === userId);
        if (existing) {
          existing.sessionString = sessionString;
          existing.active = true;
          existing.updatedAt = now;
        } else {
          this.backing.sessions.push({
            userId,
            sessionString,
            active: true,
            createdAt: now,
            updatedAt: now
          });
        }
        this.backing.persist();
        return;
      }
      case "analytics.insert": {
        const [event, props, createdAt] = args as [string, Record<string, unknown>, string];
        this.backing.analyticsEvents.push({ event, props, createdAt });
        this.backing.persist();
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
        const existing = this.backing.users.find((u) => u.telegramId === telegramId);
        if (existing) {
          if (username.trim()) existing.username = username;
          if (firstName.trim()) existing.firstName = firstName;
          if (lastName.trim()) existing.lastName = lastName;
          existing.lastSeenAt = now;
        } else {
          this.backing.users.push({
            telegramId,
            username,
            firstName,
            lastName,
            lastSeenAt: now
          });
        }
        this.backing.persist();
        return;
      }
      case "group_chats.upsert_if_needed": {
        const [chatId, now] = args as [number, string];
        if (chatId >= 0) return;
        const existing = this.backing.groupChats.find((g) => g.telegramId === chatId);
        if (existing) {
          existing.lastSeenAt = now;
        } else {
          this.backing.groupChats.push({
            telegramId: chatId,
            firstSeenAt: now,
            lastSeenAt: now
          });
        }
        this.backing.persist();
        return;
      }
      default:
        throw new Error(`unknown write query: ${query}`);
    }
  }

  read<T>(query: string, cacheLifetimeMs = 0, ...args: unknown[]): T {
    const now = Date.now();
    const cacheKey = this.buildCacheKey(query, args);
    if (cacheLifetimeMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && now < cached.expiresAt) {
        return cached.value as T;
      }
    }

    const result = this.executeRead<T>(query, args);
    if (cacheLifetimeMs > 0) {
      this.cache.set(cacheKey, {
        expiresAt: now + cacheLifetimeMs,
        value: result
      });
    }
    return result;
  }

  private executeRead<T>(query: string, args: unknown[]): T {
    switch (query) {
      case "messages.count_by_sender": {
        const [senderId] = args as [string];
        return this.backing.messages.filter((m) => m.senderId === senderId).length as T;
      }
      case "sessions.list_active": {
        return this.backing.sessions
          .filter((s) => s.active)
          .map((s) => ({
            userId: s.userId,
            sessionString: s.sessionString,
            active: s.active
          })) as T;
      }
      case "sessions.find_by_user_id": {
        const [userId] = args as [string];
        const row = this.backing.sessions.find((s) => s.userId === userId);
        if (!row) return null as T;
        return {
          userId: row.userId,
          sessionString: row.sessionString,
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

  private invalidateCache(): void {
    this.cache.clear();
  }
}
