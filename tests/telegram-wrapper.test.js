"use strict";

const TelegramBotWrapper = require("../src/bot/TelegramBot");
const logger = require("../src/utils/logger");

function createBotMock() {
  return {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(true),
    sendChatAction: jest.fn().mockResolvedValue(true),
    onText: jest.fn(),
    on: jest.fn(),
    stopPolling: jest.fn(),
  };
}

describe("TelegramBotWrapper", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("safeSend returns Telegram sendMessage result", async () => {
    const bot = createBotMock();
    const wrapper = new TelegramBotWrapper({ bot });

    await expect(wrapper.safeSend(1, "hello")).resolves.toEqual({ message_id: 1 });
    expect(bot.sendMessage).toHaveBeenCalledWith(1, "hello", {});
  });

  test("safeSend returns null and logs warning on failure", async () => {
    const bot = createBotMock();
    bot.sendMessage.mockRejectedValue(new Error("send failed"));
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const wrapper = new TelegramBotWrapper({ bot });

    await expect(wrapper.safeSend(2, "hello")).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("TG", expect.stringContaining("safeSend failed"));
  });

  test("sendLong splits long text and delegates each chunk to safeSend", async () => {
    const bot = createBotMock();
    const wrapper = new TelegramBotWrapper({ bot });
    const safeSendSpy = jest.spyOn(wrapper, "safeSend").mockResolvedValue({ message_id: 1 });

    await wrapper.sendLong(3, "A".repeat(5000), { parse_mode: "Markdown" });

    expect(safeSendSpy).toHaveBeenCalledTimes(2);
    expect(safeSendSpy).toHaveBeenNthCalledWith(1, 3, expect.any(String), { parse_mode: "Markdown" });
    expect(safeSendSpy).toHaveBeenNthCalledWith(2, 3, expect.any(String), { parse_mode: "Markdown" });
  });

  test("safeEditMarkup returns null and logs warning on failure", async () => {
    const bot = createBotMock();
    bot.editMessageReplyMarkup.mockRejectedValue(new Error("edit failed"));
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const wrapper = new TelegramBotWrapper({ bot });

    await expect(wrapper.safeEditMarkup({}, { chat_id: 1, message_id: 10 })).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("TG", expect.stringContaining("safeEditMarkup failed"));
  });

  test("safeSendTyping returns null and logs warning on failure", async () => {
    const bot = createBotMock();
    bot.sendChatAction.mockRejectedValue(new Error("typing failed"));
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const wrapper = new TelegramBotWrapper({ bot });

    await expect(wrapper.safeSendTyping(7)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("TG", expect.stringContaining("safeSendTyping failed"));
  });

  test("registerCommand binds handler via onText", () => {
    const bot = createBotMock();
    const wrapper = new TelegramBotWrapper({ bot });
    const handler = jest.fn();

    wrapper.registerCommand(/\/help/, handler);
    expect(bot.onText).toHaveBeenCalledWith(/\/help/, handler);
  });

  test("onMessage and onCallbackQuery delegate to bot.on", () => {
    const bot = createBotMock();
    const wrapper = new TelegramBotWrapper({ bot });
    const onMessage = jest.fn();
    const onCallback = jest.fn();

    wrapper.onMessage(onMessage);
    wrapper.onCallbackQuery(onCallback);

    expect(bot.on).toHaveBeenNthCalledWith(1, "message", onMessage);
    expect(bot.on).toHaveBeenNthCalledWith(2, "callback_query", onCallback);
  });

  test("stop delegates to stopPolling", () => {
    const bot = createBotMock();
    const wrapper = new TelegramBotWrapper({ bot });

    wrapper.stop();
    expect(bot.stopPolling).toHaveBeenCalledTimes(1);
  });
});
