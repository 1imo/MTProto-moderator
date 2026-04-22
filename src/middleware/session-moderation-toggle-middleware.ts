import type { SessionRepository } from "../repositories/session-repository.js";

export class SessionModerationToggleMiddleware {
  constructor(private readonly sessions: SessionRepository) {}

  async isEnabled(sessionId: string): Promise<boolean> {
    const record = await this.sessions.findByUserId(sessionId);
    return record?.active !== false;
  }
}
