"use strict";

class MessageHandler {
  constructor({
    getBot,
    getState,
    sessionManager,
    ensureSession,
    sendPromptAsync,
    startTyping,
    stopTyping,
    sendLong,
    fetchLastAssistantText,
    questionHandler,
  }) {
    this.getBot = getBot;
    this.getState = getState;
    this.sessionManager = sessionManager;
    this.ensureSession = ensureSession;
    this.sendPromptAsync = sendPromptAsync;
    this.startTyping = startTyping;
    this.stopTyping = stopTyping;
    this.sendLong = sendLong;
    this.fetchLastAssistantText = fetchLastAssistantText;
    this.questionHandler = questionHandler;
  }

  async handleUserMessage(chatId, text) {
    const bot = this.getBot();
    const state = this.getState(chatId);

    if (state.questionState) {
      await this.questionHandler.handleCustomAnswer(chatId, text);
      return;
    }

    if (state.busy) {
      this.sessionManager.queueMessage(chatId, text);
      await bot.sendMessage(chatId, "⏳ Still working on the previous request, I'll reply to this next.").catch(() => {});
      return;
    }

    state.busy = true;
    this.startTyping(chatId);

    try {
      const sessionId = await this.ensureSession(chatId);
      await this.sendPromptAsync(sessionId, text);
    } catch (err) {
      state.busy = false;
      this.stopTyping(chatId);
      console.error(`[handleUserMessage] chatId=${chatId}:`, err.message);
      await this.sendLong(chatId, `Failed to send message to OpenCode:\n${err.message}\n\nIs OpenCode running? Try: opencode serve`);
    }
  }

  async drainQueue(chatId) {
    const next = this.sessionManager.dequeueMessage(chatId);
    if (next === null || next === undefined) return;
    await this.handleUserMessage(chatId, next);
  }

  async handleSessionIdle(chatId, sessionId) {
    const bot = this.getBot();
    this.stopTyping(chatId);
    this.sessionManager.markIdle(chatId);

    try {
      const text = await this.fetchLastAssistantText(sessionId);
      if (text) {
        await this.sendLong(chatId, text);
      } else {
        await bot.sendMessage(chatId, "_(no response)_").catch(() => {});
      }
    } catch (err) {
      console.error(`[handleSessionIdle] fetch failed:`, err.message);
      await bot.sendMessage(chatId, `OpenCode finished but could not retrieve the response: ${err.message}`).catch(() => {});
    }

    await this.drainQueue(chatId);
  }

  async handleSessionError(chatId, error) {
    const bot = this.getBot();
    this.stopTyping(chatId);
    this.sessionManager.markIdle(chatId);

    const name = error && error.name ? error.name : "Error";
    const message = (error && error.data && error.data.message) || (error && error.message) || JSON.stringify(error);
    await bot.sendMessage(chatId, `❌ *${name}*: ${message}`, { parse_mode: "Markdown" }).catch(() => {});

    await this.drainQueue(chatId);
  }
}

module.exports = MessageHandler;
