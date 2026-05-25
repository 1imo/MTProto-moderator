/**
 * Short-lived in-process dedupe for (chat_id, message_id) across MTProto + Bot API paths.
 * Not shared across multiple Node processes; tradeoff to avoid DB round-trips.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_KEYS = 100_000;

export class InboundMessageDedupe {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private ops = 0;

  constructor(options?: { ttlMs?: number; maxKeys?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxKeys = options?.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** @returns true if this is the first time we see this id in the TTL window */
  tryClaim(chatId: string, messageId: number): boolean {
    const now = Date.now();
    const key = `${chatId}:${messageId}`;
    const until = this.seen.get(key);
    if (until != null && until > now) {
      return false;
    }
    this.seen.set(key, now + this.ttlMs);
    this.ops += 1;
    if (this.ops % 500 === 0 || this.seen.size > this.maxKeys) {
      this.pruneExpired(now);
    }
    if (this.seen.size > this.maxKeys) {
      this.trimArbitrary();
    }
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
  }

  private trimArbitrary(): void {
    const drop = Math.ceil(this.seen.size * 0.2);
    let n = 0;
    for (const k of this.seen.keys()) {
      this.seen.delete(k);
      n += 1;
      if (n >= drop) break;
    }
  }
}
