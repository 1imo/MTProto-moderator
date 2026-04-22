import { env } from "./utils/env.js";
import { Store } from "./utils/db/root.js";
import process from "node:process";
import { ActionQueueService } from "./bg-services/action-queue-service.js";
import { AuthHttpService } from "./bg-services/auth-http-service.js";
import { MgmtBotService } from "./bg-services/mgmt-bot-service.js";
import { MtprotoListenerService } from "./bg-services/mtproto-listener-service.js";
import { BotController } from "./controllers/bot-controller.js";
import { MtprotoController } from "./controllers/mtproto-controller.js";
import { HandleUserMiddleware } from "./middleware/handle-user-middleware.js";
import { SessionModerationToggleMiddleware } from "./middleware/session-moderation-toggle-middleware.js";
import { ActionLogRepository } from "./repositories/action-log-repository.js";
import { MessageRepository } from "./repositories/message-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";
import { AuthChallengeService } from "./services/auth-challenge-service.js";
import { ClientNotificationService } from "./services/client-notification-service.js";
import { OnboardingUseCase } from "./use-cases/onboarding.js";
import { BotRoutes } from "./routes/bot.js";
import { MtprotoRoutes } from "./routes/mtproto.js";
import { Analytics } from "./utils/analytics.js";
import { Logger } from "./utils/logger.js";
import { HandlePolicyUseCase } from "./use-cases/handle-policy.js";
import { ProcessIncomingMessageUseCase } from "./use-cases/process-incoming-message.js";
import { ExecuteModerationActionUseCase } from "./use-cases/execute-moderation-action.js";
import { ToggleModerationUseCase } from "./use-cases/toggle-moderation.js";

export const store = new Store();

void startApp();

export async function startApp(): Promise<void> {
  const logger = new Logger();
  const analytics = new Analytics(store, logger);
  const handleUserMiddleware = new HandleUserMiddleware(store, analytics);
  const messages = new MessageRepository(store);
  const actionLogs = new ActionLogRepository(store);
  const sessions = new SessionRepository(store);
  const sessionModerationToggle = new SessionModerationToggleMiddleware(sessions);
  const executeModerationAction = new ExecuteModerationActionUseCase(logger);
  const actionQueue = new ActionQueueService(logger);
  const authChallenges = new AuthChallengeService();
  const notifications = new ClientNotificationService(logger);
  const handlePolicyUseCase = new HandlePolicyUseCase(notifications, analytics, logger);
  const toggleModerationUseCase = new ToggleModerationUseCase(sessions, notifications, analytics, logger);

  const useCase = new ProcessIncomingMessageUseCase(
    messages,
    actionLogs,
    executeModerationAction,
    actionQueue,
    analytics,
    logger,
    notifications
  );

  const mtprotoController = new MtprotoController(useCase, logger);
  const mtprotoRoutes = new MtprotoRoutes(mtprotoController, sessionModerationToggle);
  const mtprotoService = new MtprotoListenerService(
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
    env.TELEGRAM_USE_WSS,
    env.TELEGRAM_CONNECT_TIMEOUT_MS,
    mtprotoRoutes,
    logger
  );

  const onboarding = new OnboardingUseCase(
    authChallenges,
    sessions,
    mtprotoService,
    notifications,
    analytics,
    logger
  );

  const authHttpService = new AuthHttpService(env.AUTH_HTTP_PORT, authChallenges, logger);
  const botController = new BotController(onboarding, toggleModerationUseCase, notifications, logger);
  const botService = new MgmtBotService(
    env.MGMT_BOT_TOKEN,
    (bot) =>
      new BotRoutes(bot, { controller: botController, handleUserMiddleware, handlePolicyUseCase }).bind(),
    notifications,
    logger
  );

  await mtprotoService.startActiveSessions(await sessions.listActive());
  await authHttpService.start();
  await botService.start();

  const shutdown = async () => {
    logger.info("shutdown_requested");
    await botService.stop();
    await authHttpService.stop();
    await mtprotoService.stop();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
