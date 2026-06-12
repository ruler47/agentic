import { HttpToolAdapter } from "./httpToolAdapter.js";
import type { Tool } from "./tool.js";

export function createChannelTelegramTool(): Tool {
  return new HttpToolAdapter({
    name: "channel.telegram",
    version: "1.0.0",
    description:
      "Always-on Telegram channel adapter that receives provider messages and delivers neutral outbound channel events.",
    capabilities: ["messaging-channel", "telegram-bridge", "background-service", "always-on-channel"],
    startupMode: "always-on",
    baseUrl: process.env.CHANNEL_TELEGRAM_BASE_URL ?? process.env.TELEGRAM_BOT_BASE_URL ?? "http://telegram-bot:8080",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "sendMessage", "pollOnce"] },
        chatId: { type: "string" },
        text: { type: "string" },
        replyToMessageId: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        content: { type: "string" },
        data: { type: "object" },
      },
      required: ["ok", "content"],
    },
  });
}
