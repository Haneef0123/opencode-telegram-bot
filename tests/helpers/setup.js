"use strict";

/**
 * Creates a mock fetch that returns canned responses based on URL path.
 * @param {Object} responses - map of pathname (e.g. "/session") → { ok, status, body }
 */
function createMockFetch(responses = {}) {
  return jest.fn().mockImplementation(async (url, opts) => {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    const response = responses[pathname] || { ok: true, status: 200, body: "{}" };
    const body = response.body;
    return {
      ok: response.ok !== undefined ? response.ok : true,
      status: response.status !== undefined ? response.status : 200,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
      body: response.stream || null,
    };
  });
}

/**
 * Creates a mock Telegram bot with all required methods as jest.fn().
 */
function createMockBot() {
  return {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    sendChatAction: jest.fn().mockResolvedValue(true),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(true),
    answerCallbackQuery: jest.fn().mockResolvedValue(true),
    stopPolling: jest.fn(),
  };
}

/**
 * Resets all bot module state between tests.
 */
function resetBotState(botModule) {
  botModule.chatState.clear();
  botModule.sessionToChat.clear();
  jest.clearAllTimers();
}

module.exports = { createMockFetch, createMockBot, resetBotState };
