"use strict";

class SessionManager {
  constructor({ maxQueueLength = 10 } = {}) {
    this.maxQueueLength = maxQueueLength;
    this.chatState = new Map();
    this.sessionToChat = new Map();
  }

  getState(chatId) {
    if (!this.chatState.has(chatId)) {
      this.chatState.set(chatId, {
        sessionId: null,
        busy: false,
        pendingQueue: [],
        typingTimer: null,
        pendingPermission: null,
        questionState: null,
      });
    }
    return this.chatState.get(chatId);
  }

  resetInteractions(chatId) {
    const state = this.getState(chatId);
    if (state.pendingPermission) {
      clearTimeout(state.pendingPermission.timer);
      state.pendingPermission = null;
    }
    if (state.questionState) {
      clearTimeout(state.questionState.timer);
      state.questionState = null;
    }
  }

  markIdle(chatId) {
    const state = this.getState(chatId);
    state.busy = false;
    this.resetInteractions(chatId);
  }

  markBusy(chatId) {
    const state = this.getState(chatId);
    state.busy = true;
  }

  async ensureSession(chatId, createSessionFn) {
    const state = this.getState(chatId);
    if (state.sessionId) return state.sessionId;
    const id = await createSessionFn(chatId);
    state.sessionId = id;
    this.sessionToChat.set(id, chatId);
    return id;
  }

  async rehydrateSessions(fetchSessionsFn) {
    try {
      const sessions = await fetchSessionsFn();
      if (!Array.isArray(sessions)) return;

      for (const s of sessions) {
        const match = s.title && s.title.match(/^Telegram Chat (-?\d+)$/);
        if (!match) continue;

        const chatId = parseInt(match[1], 10);
        this.sessionToChat.set(s.id, chatId);
        const state = this.getState(chatId);

        if (!state.sessionId) {
          state.sessionId = s.id;
          continue;
        }

        const currentSessions = sessions.filter((x) => {
          const m = x.title && x.title.match(/^Telegram Chat (-?\d+)$/);
          return m && parseInt(m[1], 10) === chatId;
        });
        const newest = currentSessions.reduce((a, b) =>
          (a.time && a.time.updated ? a.time.updated : 0) >
          (b.time && b.time.updated ? b.time.updated : 0) ? a : b
        );
        state.sessionId = newest.id;
        for (const cs of currentSessions) {
          this.sessionToChat.set(cs.id, chatId);
        }
      }
    } catch (err) {
      console.error(`[rehydrateSessions] ${err.message}`);
    }
  }

  resetChat(chatId) {
    const state = this.getState(chatId);
    this.resetInteractions(chatId);
    if (state.sessionId) this.sessionToChat.delete(state.sessionId);
    state.sessionId = null;
    state.busy = false;
    state.pendingQueue = [];
    state.typingTimer = null;
  }

  queueMessage(chatId, text) {
    const state = this.getState(chatId);
    if (state.pendingQueue.length >= this.maxQueueLength) {
      state.pendingQueue.shift();
    }
    state.pendingQueue.push(text);
  }

  dequeueMessage(chatId) {
    const state = this.getState(chatId);
    if (!state.pendingQueue.length) return null;
    return state.pendingQueue.shift();
  }
}

module.exports = SessionManager;
