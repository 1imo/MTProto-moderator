import { env } from "./utils/env.js";
import { Store } from "./utils/db/root.js";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import { ActionQueueService } from "./bg-services/action-queue-service.js";
import { AuthHttpService } from "./bg-services/auth-http-service.js";
import { MgmtBotService } from "./bg-services/mgmt-bot-service.js";
import { MtprotoListenerService } from "./bg-services/mtproto-listener-service.js";
import { BotController } from "./controllers/bot-controller.js";
import { MtprotoController } from "./controllers/mtproto-controller.js";
import { HandleUserMiddleware } from "./middleware/handle-user-middleware.js";
import { ActionLogRepository } from "./repositories/action-log-repository.js";
import { MessageRepository } from "./repositories/message-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";
import { ActionService } from "./services/action-service.js";
import { AuthChallengeService } from "./services/auth-challenge-service.js";
import { ClientNotificationService } from "./services/client-notification-service.js";
import { OnboardingUseCase } from "./use-cases/onboarding.js";
import { BotRoutes } from "./routes/bot.js";
import { MtprotoRoutes } from "./routes/mtproto.js";
import { Analytics } from "./utils/analytics.js";
import { Logger } from "./utils/logger.js";
import { ProcessIncomingMessageUseCase } from "./use-cases/process-incoming-message.js";

export const store = new Store();

void startApp();

function getFirstLocalIpv4(): string {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const net of values ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

export async function startApp(): Promise<void> {
  const logger = new Logger();
  const analytics = new Analytics(store, logger);
  const handleUserMiddleware = new HandleUserMiddleware(store, analytics);
  const messages = new MessageRepository(store);
  const actionLogs = new ActionLogRepository(store);
  const sessions = new SessionRepository(store);

  const firstMessageReplyText = fs
    .readFileSync(path.resolve("assets/messages/message.txt"), "utf8")
    .trim();
  const actionService = new ActionService(logger);
  const actionQueue = new ActionQueueService(logger);
  const authChallenges = new AuthChallengeService();
  const notifications = new ClientNotificationService(logger);

  const authHostBase =
    env.AUTH_HOST_BASE && env.AUTH_HOST_BASE.trim().length > 0
      ? env.AUTH_HOST_BASE
      : `http://${getFirstLocalIpv4()}:${env.AUTH_HTTP_PORT}`;

  const useCase = new ProcessIncomingMessageUseCase(
    messages,
    actionLogs,
    actionService,
    actionQueue,
    analytics,
    logger,
    firstMessageReplyText,
    notifications
  );

  const mtprotoController = new MtprotoController(useCase, logger);
  const mtprotoRoutes = new MtprotoRoutes(mtprotoController);
  const mtprotoService = new MtprotoListenerService(
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
    env.TELEGRAM_USE_WSS,
    env.TELEGRAM_CONNECT_TIMEOUT_MS,
    mtprotoRoutes,
    logger
  );

  const onboarding = new OnboardingUseCase(
    authHostBase,
    authChallenges,
    sessions,
    mtprotoService,
    logger
  );

  const authHttpService = new AuthHttpService(env.AUTH_HTTP_PORT, authChallenges, logger);
  const botController = new BotController(onboarding, notifications, logger);
  const botService = new MgmtBotService(
    env.MGMT_BOT_TOKEN,
    (bot) => new BotRoutes(bot, { controller: botController, handleUserMiddleware }).bind(),
    notifications,
    logger
  );

  await mtprotoService.startActiveSessions(sessions.listActive());
  await authHttpService.start();
  await botService.start();

  const shutdown = async () => {
    logger.info("shutdown_requested");
    await botService.stop();
    await authHttpService.stop();
    await mtprotoService.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
