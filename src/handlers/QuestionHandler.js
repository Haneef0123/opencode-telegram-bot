"use strict";

class QuestionHandler {
  constructor({
    getBot,
    getState,
    replyQuestion,
    rejectQuestion,
    startTyping,
    stopTyping,
    interactionTimeoutMs,
  }) {
    this.getBot = getBot;
    this.getState = getState;
    this.replyQuestion = replyQuestion;
    this.rejectQuestion = rejectQuestion;
    this.startTyping = startTyping;
    this.stopTyping = stopTyping;
    this.interactionTimeoutMs = interactionTimeoutMs;
  }

  async handleAsked(chatId, req) {
    const state = this.getState(chatId);

    if (state.questionState) {
      clearTimeout(state.questionState.timer);
      state.questionState = null;
    }

    this.stopTyping(chatId);

    const { id: requestId, questions } = req;
    if (!questions || !questions.length) {
      await this.rejectQuestion(requestId).catch(() => {});
      this.startTyping(chatId);
      return;
    }

    state.questionState = {
      requestId,
      questions,
      answers: [],
      currentIdx: 0,
      timer: setTimeout(async () => {
        const qs = state.questionState;
        if (!qs) return;
        state.questionState = null;
        await this.rejectQuestion(requestId).catch(() => {});
        await this.getBot().sendMessage(chatId, "⚠️ Question timed out — skipped.").catch(() => {});
      }, this.interactionTimeoutMs),
    };

    await this.askCurrent(chatId);
  }

  async askCurrent(chatId) {
    const bot = this.getBot();
    const state = this.getState(chatId);
    const qs = state.questionState;
    if (!qs) return;

    const q = qs.questions[qs.currentIdx];
    const total = qs.questions.length;
    const idx = qs.currentIdx;
    const prefix = total > 1 ? `*Question ${idx + 1} of ${total}*\n\n` : "";
    const text = `${prefix}${q.question}`;

    if (q.options && q.options.length) {
      const rows = q.options.map((opt, optIdx) => [
        {
          text: opt.label,
          callback_data: `qans:${qs.requestId}:${idx}:${optIdx}`,
        },
      ]);

      const customAllowed = q.custom !== false;
      const footer = customAllowed ? `\n\n_Or type your own answer_` : "";

      await bot.sendMessage(chatId, text + footer, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      }).catch((err) => console.error(`[askCurrentQuestion] send failed:`, err.message));
      return;
    }

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
  }

  async handleCustomAnswer(chatId, text) {
    const bot = this.getBot();
    const state = this.getState(chatId);
    const qs = state.questionState;
    if (!qs) return;

    const q = qs.questions[qs.currentIdx];
    const customAllowed = q.custom !== false;
    if (!customAllowed) {
      await bot.sendMessage(chatId, "Please choose one of the options above.").catch(() => {});
      return;
    }

    await this.advanceAnswer(chatId, text);
  }

  async advanceAnswer(chatId, selectedLabel) {
    const bot = this.getBot();
    const state = this.getState(chatId);
    const qs = state.questionState;
    if (!qs) return;

    qs.answers.push([selectedLabel]);
    qs.currentIdx++;

    if (qs.currentIdx < qs.questions.length) {
      await this.askCurrent(chatId);
      return;
    }

    clearTimeout(qs.timer);
    state.questionState = null;

    try {
      await this.replyQuestion(qs.requestId, qs.answers);
      await bot.sendMessage(chatId, "✅ Answers submitted, continuing...").catch(() => {});
      this.startTyping(chatId);
    } catch (err) {
      console.error(`[advanceQuestionAnswer] reply failed:`, err.message);
      await bot.sendMessage(chatId, `Failed to submit answers: ${err.message}`).catch(() => {});
    }
  }

  async handleCallback(chatId, data, messageId, state) {
    if (!data.startsWith("qans:")) return false;
    const bot = this.getBot();

    const parts = data.split(":");
    const requestId = parts[1];
    const questionIdx = parseInt(parts[2], 10);
    const optionIdx = parseInt(parts[3], 10);

    if (state.questionState && state.questionState.requestId === requestId) {
      if (state.questionState.currentIdx !== questionIdx) {
        return true;
      }

      const q = state.questionState.questions[questionIdx];
      const option = q.options && q.options[optionIdx];
      if (!option) {
        await bot.sendMessage(chatId, "⚠️ Invalid option selected.").catch(() => {});
        return true;
      }
      const label = option.label;

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});
      await bot.sendMessage(chatId, `Selected: *${label}*`, { parse_mode: "Markdown" }).catch(() => {});

      await this.advanceAnswer(chatId, label);
      return true;
    }

    await bot.sendMessage(chatId, "⏳ Still reconnecting — please wait a moment and try tapping again.").catch(() => {});
    return true;
  }
}

module.exports = QuestionHandler;
