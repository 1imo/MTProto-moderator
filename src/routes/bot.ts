import type { Telegraf } from "telegraf";
import type { BotController } from "../controllers/bot-controller.js";
import type { HandleUserMiddleware } from "../middleware/handle-user-middleware.js";

export type BotRouteDeps = {
  controller: BotController;
  handleUserMiddleware: HandleUserMiddleware;
};

export class BotRoutes {
  constructor(
    private readonly bot: Telegraf,
    private readonly deps: BotRouteDeps
  ) {}

  bind(): void {
    const { controller, handleUserMiddleware } = this.deps;

    this.bot.command("start", async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId) return;
      await handleUserMiddleware.ensureUser(
        {
          telegramId: userId,
          username: ctx.from?.username ?? "",
          firstName: ctx.from?.first_name ?? "",
          lastName: ctx.from?.last_name ?? ""
        },
        chatId ?? userId
      );
      await controller.handleStart(userId);
    });

    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      const text = ctx.message.text;
      if (!userId || text.startsWith("/")) return;
      await handleUserMiddleware.ensureUser(
        {
          telegramId: userId,
          username: ctx.from?.username ?? "",
          firstName: ctx.from?.first_name ?? "",
          lastName: ctx.from?.last_name ?? ""
        },
        chatId ?? userId
      );
      await controller.handleText(userId, text);
    });
  }
}
