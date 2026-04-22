import type { SessionRepository } from "../repositories/session-repository.js";
import type { ClientNotificationService } from "../services/client-notification-service.js";
import type { Analytics } from "../utils/analytics.js";
import type { Logger } from "../utils/logger.js";

export class ToggleModerationUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly notifications: ClientNotificationService,
    private readonly analytics: Analytics,
    private readonly logger: Logger
  ) {}

  async execute(userId: number): Promise<void> {
    const record = await this.sessions.findByUserId(String(userId));
    if (!record) {
      await this.notifications.sendToClient(
        String(userId),
        "No active onboarding session found. Send /start first."
      );
      return;
    }

    const nextActive = !record.active;
    await this.sessions.setActive(String(userId), nextActive);
    this.analytics.trackEvent("moderation_toggled", { userId, active: nextActive });
    this.logger.info("moderation_toggled", { userId, active: nextActive });
    await this.notifications.sendToClient(
      String(userId),
      nextActive ? "Moderation is now ON." : "Moderation is now OFF."
    );
  }
}
