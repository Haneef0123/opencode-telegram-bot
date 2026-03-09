"use strict";

const { createMockFetch, createMockBot, resetBotState } = require("./helpers/setup");

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const botModule = require("../bot");

let mockBot;

beforeEach(() => {
  resetBotState(botModule);
  mockBot = createMockBot();
  botModule.setBotInstance(mockBot);
  global.fetch = createMockFetch();
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("getState", () => {
  test("creates default state for new chatId", () => {
    const state = botModule.getState(9001);
    expect(state).toEqual({
      sessionId: null,
      busy: false,
      pendingQueue: [],
      typingTimer: null,
      pendingPermission: null,
      questionState: null,
    });
  });

  test("returns same object on repeated calls (referential equality)", () => {
    const a = botModule.getState(9002);
    const b = botModule.getState(9002);
    expect(a).toBe(b);
  });

  test("different chatIds return different objects", () => {
    const a = botModule.getState(9003);
    const b = botModule.getState(9004);
    expect(a).not.toBe(b);
  });

  test("mutations persist across calls", () => {
    botModule.getState(9005).busy = true;
    expect(botModule.getState(9005).busy).toBe(true);
  });

  test("chatState.clear() resets all state", () => {
    botModule.getState(9006).busy = true;
    botModule.chatState.clear();
    expect(botModule.getState(9006).busy).toBe(false);
  });
});

describe("sessionToChat", () => {
  test("maps sessionId to chatId", () => {
    botModule.sessionToChat.set("sess-abc", 42);
    expect(botModule.sessionToChat.get("sess-abc")).toBe(42);
  });

  test("multiple sessions can map to same chatId", () => {
    botModule.sessionToChat.set("sess-1", 99);
    botModule.sessionToChat.set("sess-2", 99);
    expect(botModule.sessionToChat.get("sess-1")).toBe(99);
    expect(botModule.sessionToChat.get("sess-2")).toBe(99);
  });

  test("delete removes mapping", () => {
    botModule.sessionToChat.set("sess-del", 77);
    botModule.sessionToChat.delete("sess-del");
    expect(botModule.sessionToChat.has("sess-del")).toBe(false);
  });
});
