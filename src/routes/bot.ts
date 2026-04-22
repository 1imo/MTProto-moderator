import type { Telegraf } from "telegraf";
import type { BotController } from "../controllers/bot-controller.js";
import type { HandleUserMiddleware } from "../middleware/handle-user-middleware.js";
import type { HandlePolicyUseCase } from "../use-cases/handle-policy.js";

export type BotRouteDeps = {
  controller: BotController;
  handleUserMiddleware: HandleUserMiddleware;
  handlePolicyUseCase: HandlePolicyUseCase;
};

export class BotRoutes {
  constructor(
    private readonly bot: Telegraf,
    private readonly deps: BotRouteDeps
  ) {}

  bind(): void {
    const { controller, handleUserMiddleware, handlePolicyUseCase } = this.deps;

    this.bot.on("text", async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      const text = ctx.message.text;
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

      if (text.startsWith("/")) {
        const command = text.split(/\s+/)[0].toLowerCase();
        switch (command) {
          case "/start":
            await controller.handleStart(userId);
            return;
          case "/help":
          case "/terms":
          case "/commitment":
          case "/sponsor":
            await handlePolicyUseCase.execute(userId, command);
            return;
          case "/toggle":
            await controller.handleToggleOnOff(userId);
            return;
          default:
            return;
        }
      }

      await controller.handleText(userId, text);
    });
  }
}
