"use strict";

const { createMockFetch, createMockBot, resetBotState } = require("./helpers/setup");

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const botModule = require("../bot");

let mockBot;

beforeEach(() => {
  jest.useFakeTimers();
  resetBotState(botModule);
  mockBot = createMockBot();
  botModule.setBotInstance(mockBot);
  global.fetch = createMockFetch();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("startTyping", () => {
  test("calls sendChatAction('typing') immediately", () => {
    botModule.startTyping(100);
    expect(mockBot.sendChatAction).toHaveBeenCalledWith(100, "typing");
  });

  test("is idempotent: calling twice doesn't create two timers", () => {
    botModule.startTyping(101);
    const timerBefore = botModule.getState(101).typingTimer;
    botModule.startTyping(101);
    const timerAfter = botModule.getState(101).typingTimer;
    expect(timerBefore).toBe(timerAfter);
    // second call should NOT fire sendChatAction again
    expect(mockBot.sendChatAction).toHaveBeenCalledTimes(1);
  });

  test("refreshes typing every TYPING_INTERVAL_MS", () => {
    botModule.startTyping(102);
    expect(mockBot.sendChatAction).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(botModule.TYPING_INTERVAL_MS);
    expect(mockBot.sendChatAction).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(botModule.TYPING_INTERVAL_MS);
    expect(mockBot.sendChatAction).toHaveBeenCalledTimes(3);
  });

  test("stopTyping clears the timer", () => {
    botModule.startTyping(103);
    expect(botModule.getState(103).typingTimer).not.toBeNull();
    botModule.stopTyping(103);
    expect(botModule.getState(103).typingTimer).toBeNull();
  });

  test("stopTyping is safe to call when not typing", () => {
    expect(() => botModule.stopTyping(104)).not.toThrow();
  });

  test("sendChatAction errors are silently caught", async () => {
    mockBot.sendChatAction.mockRejectedValue(new Error("Telegram error"));
    // Should not throw
    expect(() => botModule.startTyping(105)).not.toThrow();
    // Advance to let the rejected promise settle
    await Promise.resolve();
  });
});
