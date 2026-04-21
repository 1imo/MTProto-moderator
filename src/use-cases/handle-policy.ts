import path from "node:path";
import type { Analytics } from "../utils/analytics.js";
import type { Logger } from "../utils/logger.js";
import type { ClientNotificationService } from "../services/client-notification-service.js";

export class HandlePolicyUseCase {
  constructor(
    private readonly notifications: ClientNotificationService,
    private readonly analytics: Analytics,
    private readonly logger: Logger
  ) {}

  async execute(userId: number, command: string): Promise<void> {
    const normalized = command.toLowerCase();
    this.analytics.trackEvent("policy_requested", { userId, command: normalized });
    let filePath = "";
    switch (normalized) {
      case "/help":
        filePath = path.resolve("assets/policies/help.html");
        break;
      case "/terms":
        filePath = path.resolve("assets/policies/terms.html");
        break;
      case "/commitment":
        filePath = path.resolve("assets/policies/commitment.html");
        break;
      default:
        return;
    }

    const sent = await this.notifications.sendHTMLFile(String(userId), filePath);
    this.analytics.trackEvent("policy_sent", { userId, command: normalized, sent });
    if (!sent) {
      this.logger.warn("policy_send_failed", { userId, command: normalized, filePath });
    }
  }
}
