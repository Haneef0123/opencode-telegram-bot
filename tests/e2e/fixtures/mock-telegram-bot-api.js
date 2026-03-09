"use strict";

let globalMessageId = 1000;
let globalCallbackId = 5000;

class MockTelegramBot {
  constructor(token, options = {}) {
    this.token = token;
    this.options = options;
    this._handlers = new Map();
    this._textHandlers = [];

    process.on("message", async (msg) => {
      if (!msg || msg.__channel !== "mock-telegram") return;
      try {
        if (msg.type === "emitMessage") {
          await this._emitMessage(msg.payload || {});
        }
        if (msg.type === "emitCallback") {
          await this._emitCallback(msg.payload || {});
        }
      } catch (err) {
        this._send("handlerError", { message: err.message });
      }
    });

    this._send("init", { tokenPresent: Boolean(token), polling: Boolean(options.polling) });
  }

  on(event, handler) {
    const existing = this._handlers.get(event) || [];
    existing.push(handler);
    this._handlers.set(event, existing);
  }

  onText(regex, handler) {
    this._textHandlers.push({ regex, handler });
  }

  async sendMessage(chatId, text, opts = {}) {
    const message_id = ++globalMessageId;
    this._send("sendMessage", { chatId, text, opts, message_id });
    return {
      message_id,
      chat: { id: chatId },
      text,
    };
  }

  async sendChatAction(chatId, action) {
    this._send("sendChatAction", { chatId, action });
    return true;
  }

  async editMessageReplyMarkup(replyMarkup, options) {
    this._send("editMessageReplyMarkup", { replyMarkup, options });
    return true;
  }

  async answerCallbackQuery(id) {
    this._send("answerCallbackQuery", { id });
    return true;
  }

  stopPolling() {
    this._send("stopPolling", {});
  }

  async _emitMessage(payload) {
    const chatId = payload.chatId;
    const text = payload.text || "";
    const messageId = payload.message_id || ++globalMessageId;

    const msg = {
      message_id: messageId,
      chat: { id: chatId, type: "private" },
      text,
      date: Math.floor(Date.now() / 1000),
    };

    // node-telegram-bot-api emits message handlers for all texts.
    const messageHandlers = this._handlers.get("message") || [];
    for (const handler of messageHandlers) {
      await Promise.resolve(handler(msg));
    }

    for (const { regex, handler } of this._textHandlers) {
      regex.lastIndex = 0;
      const match = text.match(regex);
      if (match) {
        await Promise.resolve(handler(msg, match));
      }
    }
  }

  async _emitCallback(payload) {
    const chatId = payload.chatId;
    const data = payload.data || "";
    const callbackId = payload.id || `cb-${++globalCallbackId}`;
    const messageId = payload.message_id || ++globalMessageId;

    const query = {
      id: callbackId,
      data,
      from: { id: 42, is_bot: false, first_name: "E2E" },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
      },
    };

    const handlers = this._handlers.get("callback_query") || [];
    for (const handler of handlers) {
      await Promise.resolve(handler(query));
    }
  }

  _send(type, payload) {
    if (typeof process.send === "function") {
      process.send({ __channel: "mock-telegram", type, payload });
    }
  }
}

module.exports = MockTelegramBot;
