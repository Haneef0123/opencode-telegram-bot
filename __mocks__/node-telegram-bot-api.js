"use strict";

class MockTelegramBot {
  constructor() {
    this.sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
    this.sendChatAction = jest.fn().mockResolvedValue(true);
    this.editMessageReplyMarkup = jest.fn().mockResolvedValue(true);
    this.answerCallbackQuery = jest.fn().mockResolvedValue(true);
    this.stopPolling = jest.fn();
    this._handlers = {};
    this._textHandlers = [];
  }
  on(event, handler) {
    this._handlers[event] = handler;
  }
  onText(regex, handler) {
    this._textHandlers.push({ regex, handler });
  }
}

module.exports = MockTelegramBot;
