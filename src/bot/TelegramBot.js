"use strict";

const TelegramBot = require("node-telegram-bot-api");
const logger = require("../utils/logger");
const { splitMessage } = require("./messageFormatter");

class TelegramBotWrapper {
  constructor({ token, bot }) {
    this.bot = bot || new TelegramBot(token, { polling: true });
  }

  async safeSend(chatId, text, opts = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, opts);
    } catch (err) {
      logger.warn("TG", `safeSend failed chatId=${chatId}: ${err.message}`);
      return null;
    }
  }

  async sendLong(chatId, text, opts = {}) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.safeSend(chatId, chunk, opts);
    }
  }

  async safeEditMarkup(markup, opts) {
    try {
      return await this.bot.editMessageReplyMarkup(markup, opts);
    } catch (err) {
      logger.warn("TG", `safeEditMarkup failed: ${err.message}`);
      return null;
    }
  }

  async safeSendTyping(chatId) {
    try {
      return await this.bot.sendChatAction(chatId, "typing");
    } catch (err) {
      logger.warn("TG", `safeSendTyping failed chatId=${chatId}: ${err.message}`);
      return null;
    }
  }

  registerCommand(pattern, handler) {
    this.bot.onText(pattern, handler);
  }

  onMessage(handler) {
    this.bot.on("message", handler);
  }

  onCallbackQuery(handler) {
    this.bot.on("callback_query", handler);
  }

  stop() {
    this.bot.stopPolling();
  }
}

module.exports = TelegramBotWrapper;
