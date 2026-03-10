"use strict";

require("dotenv").config({ quiet: true });

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  openCodeUrl: (process.env.OPENCODE_SERVER_URL || "http://localhost:4096").replace(/\/$/, ""),
  ocUser: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  ocPass: process.env.OPENCODE_SERVER_PASSWORD || "",
  typingIntervalMs: 4000,
  interactionTimeoutMs: 10 * 60 * 1000,
  sseReconnectDelayMs: 3000,
  maxQueueLength: 10,
};

function validate() {
  if (!config.telegramToken || config.telegramToken === "your_telegram_bot_token_here") {
    console.error("[FATAL] Set TELEGRAM_BOT_TOKEN in your .env file");
    process.exit(1);
  }
}

module.exports = { config, validate };
