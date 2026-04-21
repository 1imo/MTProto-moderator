import { Telegraf } from "telegraf";
import { ClientNotificationService } from "../services/client-notification-service.js";
import type { Logger } from "../utils/logger.js";

export class MgmtBotService {
  private bot?: Telegraf;

  constructor(
    private readonly token: string | undefined,
    private readonly bindRoutes: (bot: Telegraf) => void,
    private readonly notifications: ClientNotificationService,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    if (!this.token) {
      this.logger.warn("mgmt_bot_not_started_missing_token");
      return;
    }
    const bot = new Telegraf(this.token);
    this.bindRoutes(bot);
    await bot.launch();
    this.notifications.attachBot(bot);
    this.bot = bot;
    this.logger.info("mgmt_bot_started");
  }

  async stop(): Promise<void> {
    this.bot?.stop();
  }
}
