import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { SessionRepository } from "../repositories/session-repository.js";
import { MtprotoListenerService } from "../bg-services/mtproto-listener-service.js";
import { Logger } from "../utils/logger.js";
import { AuthChallengeService } from "../services/auth-challenge-service.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import { env } from "../utils/env.js";

type Stage = "idle" | "awaiting_phone" | "authenticating" | "awaiting_code" | "awaiting_password";

type PendingState = {
  stage: Stage;
  resolveInput?: (value: string) => void;
};

export class OnboardingUseCase {
  private readonly pending = new Map<number, PendingState>();

  constructor(
    private readonly authHostBase: string,
    private readonly authChallenges: AuthChallengeService,
    private readonly sessions: SessionRepository,
    private readonly mtproto: MtprotoListenerService,
    private readonly notifications: ClientNotificationService,
    private readonly logger: Logger
  ) {}

  async onStart(userId: number): Promise<void> {
    await this.safeSend(
      userId,
      "This is a chat moderation service. for access, info, and pricing please contact @dotslashmakefile ."
    );

    const existing = this.sessions.findByUserId(String(userId));
    if (existing?.active) {
      await this.safeSend(userId, "You are already onboarded.");
      return;
    }

    this.pending.set(userId, { stage: "awaiting_phone" });
    await this.safeSend(userId, "Send your phone number in international format (example: +447700900123).");
  }

  async onText(userId: number, text: string): Promise<void> {
    this.logger.info("onboarding_text_received", { userId, textLength: text.length });

    const current = this.pending.get(userId);
    this.logger.info("onboarding_state_check", { userId, stage: current?.stage ?? "none" });
    if (!current) {
      await this.safeSend(userId, "Send /start to begin onboarding.");
      return;
    }

    if (current.stage === "awaiting_phone") {
      this.pending.set(userId, { stage: "authenticating" });
      await this.safeSend(userId, "Starting onboarding...");
      this.logger.info("onboarding_phone_received", { userId });
      void this.runAuthFlow(userId, text.trim());
      return;
    }

    if (current.stage === "awaiting_code" || current.stage === "awaiting_password") {
      await this.safeSend(userId, "Use the secure link I sent to submit this step.");
      return;
    }

    await this.safeSend(userId, "Onboarding in progress. Wait for next prompt.");
  }

  private async runAuthFlow(userId: number, phoneNumber: string): Promise<void> {
    const client = new TelegramClient(new StringSession(""), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
      connectionRetries: 5,
      useWSS: env.TELEGRAM_USE_WSS
    });

    try {
      this.logger.info("onboarding_connecting", { userId });
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`onboarding_connect_timeout timeoutMs=${env.TELEGRAM_CONNECT_TIMEOUT_MS}`));
          }, env.TELEGRAM_CONNECT_TIMEOUT_MS);
        })
      ]);
      this.logger.info("onboarding_connected", { userId });
      await this.safeSend(userId, "Connected to Telegram. Sending login code...");
      this.logger.info("onboarding_requesting_code", { userId });

      await client.signInUser(
        { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
        {
          phoneNumber,
          phoneCode: async () => {
            const challenge = this.authChallenges.create(userId, "Enter your Telegram login code.");
            const link = `${this.authHostBase}/auth/${challenge.token}`;
            await this.safeSend(userId, `Open this link and enter your login code:\n${link}`);
            this.pending.set(userId, { stage: "awaiting_code" });
            return challenge.wait;
          },
          password: async () => {
            const challenge = this.authChallenges.create(userId, "Enter your Telegram 2FA password.");
            const link = `${this.authHostBase}/auth/${challenge.token}`;
            await this.safeSend(userId, `Open this link and enter your 2FA password:\n${link}`);
            this.pending.set(userId, { stage: "awaiting_password" });
            return challenge.wait;
          },
          onError: async (err) => {
            this.logger.error("onboarding_auth_error", { userId, error: String(err), stack: err?.stack });
            await this.safeSend(userId, `Auth error: ${String(err)}`);
            return true;
          }
        }
      );

      const sessionString = String(client.session.save() ?? "");
      if (!sessionString) throw new Error("session_string_empty_after_auth");
      this.sessions.upsertActive(String(userId), sessionString);
      await this.mtproto.startForSession(String(userId), sessionString);
      await this.safeSend(userId, "Onboarding completed. Your moderation session is now active.");
      this.pending.delete(userId);
    } catch (error) {
      this.logger.error("onboarding_failed", {
        userId,
        phoneNumber,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      await this.safeSend(userId, "Onboarding failed. Send /start to retry.");
      this.pending.delete(userId);
    } finally {
      await client.disconnect();
    }
  }

  private async safeSend(userId: number, text: string): Promise<void> {
    try {
      await this.notifications.sendToClient(String(userId), text);
    } catch (error) {
      this.logger.error("onboarding_send_failed", {
        userId,
        text,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }
}
