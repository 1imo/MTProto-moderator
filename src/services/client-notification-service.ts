import { Telegraf } from "telegraf";
import fs from "node:fs";
import { Logger } from "../utils/logger.js";

export class ClientNotificationService {
  private bot?: Telegraf;

  constructor(private readonly logger: Logger) {}

  attachBot(bot: Telegraf): void {
    this.bot = bot;
  }

  async sendToClient(clientUserId: string, text: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn("client_notification_skipped_bot_unavailable", { clientUserId });
      return false;
    }

    const userId = Number(clientUserId);
    if (!Number.isFinite(userId)) {
      this.logger.warn("client_notification_skipped_invalid_user_id", { clientUserId });
      return false;
    }

    try {
      await this.bot.telegram.sendMessage(userId, text);
      this.logger.info("client_notification_sent", { clientUserId });
      return true;
    } catch (error) {
      this.logger.error("client_notification_failed", { clientUserId, error: String(error) });
      return false;
    }
  }

  async sendHTML(clientUserId: string, html: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn("client_notification_skipped_bot_unavailable", { clientUserId });
      return false;
    }

    const userId = Number(clientUserId);
    if (!Number.isFinite(userId)) {
      this.logger.warn("client_notification_skipped_invalid_user_id", { clientUserId });
      return false;
    }

    try {
      await this.bot.telegram.sendMessage(userId, html, { parse_mode: "HTML" });
      this.logger.info("client_notification_sent_html", { clientUserId });
      return true;
    } catch (error) {
      this.logger.warn("client_notification_html_failed_fallback_to_text", {
        clientUserId,
        error: String(error)
      });
      return this.sendToClient(clientUserId, this.htmlToPlainText(html));
    }
  }

  async sendHTMLFile(clientUserId: string, filePath: string): Promise<boolean> {
    try {
      const html = fs.readFileSync(filePath, "utf8");
      return await this.sendHTML(clientUserId, html);
    } catch (error) {
      this.logger.error("client_notification_html_file_failed", {
        clientUserId,
        filePath,
        error: String(error)
      });
      return false;
    }
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/\r\n/g, "\n")
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "$2 ($1)")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<(p|div|section|article|ul|ol|h1|h2|h3|h4|h5|h6)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
