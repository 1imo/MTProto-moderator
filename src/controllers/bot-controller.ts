import type { OnboardingUseCase } from "../use-cases/onboarding.js";
import type { ClientNotificationService } from "../services/client-notification-service.js";
import type { Logger } from "../utils/logger.js";

export class BotController {
  constructor(
    private readonly onboarding: OnboardingUseCase,
    private readonly notifications: ClientNotificationService,
    private readonly logger: Logger
  ) {}

  async handleStart(userId: number): Promise<void> {
    await this.guard(
      async () => {
        await this.onboarding.onStart(userId, async (text) => {
          await this.notifications.sendToClient(String(userId), text);
        });
      },
      async () => {
        await this.notifications.sendToClient(String(userId), "command failed");
      }
    );
  }

  async handleText(
    userId: number,
    text: string
  ): Promise<void> {
    await this.guard(
      async () => {
        await this.onboarding.onText(userId, text, async (reply) => {
          await this.notifications.sendToClient(String(userId), reply);
        });
      },
      async () => {
        await this.notifications.sendToClient(String(userId), "message handling failed");
      }
    );
  }

  private async guard(next: () => Promise<void>, onErrorReply: () => Promise<void>): Promise<void> {
    try {
      await next();
    } catch (error) {
      this.logger.error("bot_command_failed", { error: String(error) });
      await onErrorReply();
    }
  }
}
