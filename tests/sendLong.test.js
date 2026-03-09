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

describe("sendLong", () => {
  test("short message (<4096) sent as single message", async () => {
    await botModule.sendLong(1, "short text");
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(1, "short text", {});
  });

  test("exactly 4096 chars sent as single message", async () => {
    const text = "A".repeat(4096);
    await botModule.sendLong(2, text);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("4097 chars split into 2 messages", async () => {
    const text = "A".repeat(4097);
    await botModule.sendLong(3, text);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("8192 chars split into 2 messages of 4096 each", async () => {
    const text = "A".repeat(8192);
    await botModule.sendLong(4, text);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockBot.sendMessage.mock.calls[0][1]).toHaveLength(4096);
    expect(mockBot.sendMessage.mock.calls[1][1]).toHaveLength(4096);
  });

  test("empty string is not sent", async () => {
    await botModule.sendLong(5, "");
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  test("whitespace-only string is not sent", async () => {
    await botModule.sendLong(6, "   ");
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  test("null text is not sent", async () => {
    await botModule.sendLong(7, null);
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  test("options are passed through to each chunk", async () => {
    const text = "A".repeat(5000);
    const opts = { parse_mode: "Markdown" };
    await botModule.sendLong(8, text, opts);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockBot.sendMessage.mock.calls[0][2]).toEqual(opts);
    expect(mockBot.sendMessage.mock.calls[1][2]).toEqual(opts);
  });
});
