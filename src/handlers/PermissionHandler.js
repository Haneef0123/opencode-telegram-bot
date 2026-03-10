"use strict";

class PermissionHandler {
  constructor({
    getBot,
    getState,
    replyPermission,
    startTyping,
    stopTyping,
    interactionTimeoutMs,
  }) {
    this.getBot = getBot;
    this.getState = getState;
    this.replyPermission = replyPermission;
    this.startTyping = startTyping;
    this.stopTyping = stopTyping;
    this.interactionTimeoutMs = interactionTimeoutMs;
  }

  async handleAsked(chatId, req) {
    const bot = this.getBot();
    const state = this.getState(chatId);

    if (state.pendingPermission) {
      clearTimeout(state.pendingPermission.timer);
      state.pendingPermission = null;
    }

    this.stopTyping(chatId);

    const { id: requestId, permission, metadata = {} } = req;
    const lines = [`🔐 *Permission Request*`, ``, `OpenCode wants to: \`${permission}\``];
    if (metadata.command) lines.push(`Command: \`${metadata.command}\``);
    if (metadata.path) lines.push(`Path: \`${metadata.path}\``);
    if (metadata.description) lines.push(``, metadata.description);
    lines.push(``, `Allow this action?`);

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Allow Once", callback_data: `perm:once:${requestId}` },
          { text: "✅✅ Always Allow", callback_data: `perm:always:${requestId}` },
          { text: "❌ Deny", callback_data: `perm:reject:${requestId}` },
        ],
      ],
    };

    const sent = await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }).catch((err) => {
      console.error(`[handlePermissionAsked] send failed:`, err.message);
      return null;
    });

    if (!sent) return;

    const timer = setTimeout(async () => {
      state.pendingPermission = null;
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: sent.message_id });
        await bot.sendMessage(chatId, "⚠️ Permission request timed out — denied automatically.");
        await this.replyPermission(requestId, "reject").catch(() => {});
      } catch {}
    }, this.interactionTimeoutMs);

    state.pendingPermission = { requestId, messageId: sent.message_id, timer };
    this.startTyping(chatId);
  }

  async handleCallback(chatId, data, messageId, state) {
    if (!data.startsWith("perm:")) return false;
    const bot = this.getBot();

    const parts = data.split(":");
    const reply = parts[1];
    const requestId = parts[2];

    if (state.pendingPermission && state.pendingPermission.requestId === requestId) {
      clearTimeout(state.pendingPermission.timer);
      state.pendingPermission = null;
    }

    const replyText =
      reply === "once" ? "✅ Allowed (once)" :
      reply === "always" ? "✅ Allowed (always)" :
      "❌ Denied";

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {});
    await bot.sendMessage(chatId, replyText).catch(() => {});

    try {
      await this.replyPermission(requestId, reply);
      this.startTyping(chatId);
    } catch (err) {
      console.error(`[callback perm] reply failed:`, err.message);
      await bot.sendMessage(chatId, `Failed to send permission response: ${err.message}`).catch(() => {});
    }
    return true;
  }
}

module.exports = PermissionHandler;
