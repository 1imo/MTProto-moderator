import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import path from "node:path";
import os from "node:os";
import { SessionRepository } from "../repositories/session-repository.js";
import { MtprotoListenerService } from "../bg-services/mtproto-listener-service.js";
import { Logger } from "../utils/logger.js";
import { AuthChallengeService } from "../services/auth-challenge-service.js";
import { ClientNotificationService } from "../services/client-notification-service.js";
import { Analytics } from "../utils/analytics.js";
import { env } from "../utils/env.js";

type Stage = "idle" | "awaiting_phone" | "authenticating" | "awaiting_code" | "awaiting_password";

type PendingState = {
  stage: Stage;
  resolveInput?: (value: string) => void;
};

export class OnboardingUseCase {
  private readonly pending = new Map<number, PendingState>();

  constructor(
    private readonly authChallenges: AuthChallengeService,
    private readonly sessions: SessionRepository,
    private readonly mtproto: MtprotoListenerService,
    private readonly notifications: ClientNotificationService,
    private readonly analytics: Analytics,
    private readonly logger: Logger
  ) {}

  async onStart(userId: number): Promise<void> {
    this.analytics.trackEvent("onboarding_start", { userId });
    await this.notifications.sendHTMLFile(String(userId), path.resolve("assets/policies/start.html"));

    const existing = await this.sessions.findByUserId(String(userId));
    if (existing?.active) {
      await this.notifications.sendToClient(String(userId), "You are already onboarded.");
      return;
    }

    this.pending.set(userId, { stage: "awaiting_phone" });
    await this.notifications.sendToClient(
      String(userId),
      "Send your phone number in international format (example: +447700900123)."
    );
  }

  async onText(userId: number, text: string): Promise<void> {
    this.analytics.trackEvent("onboarding_text", { userId, textLength: text.length });
    this.logger.info("onboarding_text_received", { userId, textLength: text.length });

    const current = this.pending.get(userId);
    this.logger.info("onboarding_state_check", { userId, stage: current?.stage ?? "none" });
    if (!current) {
      await this.notifications.sendToClient(String(userId), "Send /start to begin onboarding.");
      return;
    }

    if (current.stage === "awaiting_phone") {
      this.pending.set(userId, { stage: "authenticating" });
      await this.notifications.sendToClient(String(userId), "Starting onboarding...");
      this.logger.info("onboarding_phone_received", { userId });
      void this.runAuthFlow(userId, text.trim());
      return;
    }

    if (current.stage === "awaiting_code" || current.stage === "awaiting_password") {
      await this.notifications.sendToClient(String(userId), "Use the secure link I sent to submit this step.");
      return;
    }

    await this.notifications.sendToClient(String(userId), "Onboarding in progress. Wait for next prompt.");
  }

  private async runAuthFlow(userId: number, phoneNumber: string): Promise<void> {
    const client = new TelegramClient(new StringSession(""), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
      connectionRetries: 5,
      useWSS: env.TELEGRAM_USE_WSS
    });

    try {
      const authHostBase =
        env.AUTH_HOST_BASE && env.AUTH_HOST_BASE.trim().length > 0
          ? env.AUTH_HOST_BASE
          : (() => {
              const interfaces = os.networkInterfaces();
              for (const values of Object.values(interfaces)) {
                for (const net of values ?? []) {
                  if (net.family === "IPv4" && !net.internal) {
                    return `http://${net.address}:${env.AUTH_HTTP_PORT}`;
                  }
                }
              }
              throw new Error("AUTH_HOST_BASE is required when no non-internal IPv4 address is available");
            })();

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
      await this.notifications.sendToClient(String(userId), "Connected to Telegram. Sending login code...");
      this.logger.info("onboarding_requesting_code", { userId });

      await client.signInUser(
        { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
        {
          phoneNumber,
          phoneCode: async () => {
            const challenge = this.authChallenges.create(userId, "Enter your Telegram login code.");
            const link = `${authHostBase}/auth/${challenge.token}`;
            await this.notifications.sendToClient(
              String(userId),
              `Open this link and enter your login code:\n${link}`
            );
            this.pending.set(userId, { stage: "awaiting_code" });
            return challenge.wait;
          },
          password: async () => {
            const challenge = this.authChallenges.create(userId, "Enter your Telegram 2FA password.");
            const link = `${authHostBase}/auth/${challenge.token}`;
            await this.notifications.sendToClient(
              String(userId),
              `Open this link and enter your 2FA password:\n${link}`
            );
            this.pending.set(userId, { stage: "awaiting_password" });
            return challenge.wait;
          },
          onError: async (err) => {
            this.logger.error("onboarding_auth_error", { userId, error: String(err), stack: err?.stack });
            await this.notifications.sendToClient(String(userId), `Auth error: ${String(err)}`);
            return true;
          }
        }
      );

      const sessionString = String(client.session.save() ?? "");
      if (!sessionString) throw new Error("session_string_empty_after_auth");
      await this.sessions.upsertActive(String(userId), sessionString);
      await this.mtproto.startForSession(String(userId), sessionString);
      this.analytics.trackEvent("onboarding_completed", { userId });
      await this.notifications.sendToClient(
        String(userId),
        "Onboarding completed. Your moderation session is now active."
      );
      this.pending.delete(userId);
    } catch (error) {
      this.logger.error("onboarding_failed", {
        userId,
        phoneNumber,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      this.analytics.trackEvent("onboarding_failed", { userId, error: String(error) });
      await this.notifications.sendToClient(String(userId), "Onboarding failed. Send /start to retry.");
      this.pending.delete(userId);
    } finally {
      await client.disconnect();
    }
  }
}
