"use strict";

const { createMockFetch, createMockBot, resetBotState } = require("./helpers/setup");

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const botModule = require("../bot");

let mockBot;
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetBotState(botModule);
  mockBot = createMockBot();
  botModule.setBotInstance(mockBot);
  global.fetch = createMockFetch();
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("dispatchEvent", () => {
  test("permission.asked dispatches to correct chatId via sessionToChat", () => {
    botModule.sessionToChat.set("s-perm", 900);
    botModule.dispatchEvent({
      payload: {
        type: "permission.asked",
        properties: { sessionID: "s-perm", id: "p1", permission: "file.write", metadata: {} },
      },
    });
    const [chatId, text] = mockBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(900);
    expect(text).toContain("Permission Request");
  });

  test("question.asked dispatches to correct chatId", async () => {
    botModule.sessionToChat.set("s-ques", 901);
    botModule.dispatchEvent({
      payload: {
        type: "question.asked",
        properties: {
          sessionID: "s-ques",
          id: "q1",
          questions: [{ question: "Choose one", options: [{ label: "A" }], custom: true }],
        },
      },
    });
    await flushPromises();
    const [chatId, text] = mockBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(901);
    expect(text).toContain("Choose one");
  });

  test("session.idle dispatches to correct chatId", async () => {
    botModule.sessionToChat.set("s-idle", 902);
    global.fetch = createMockFetch({
      "/session/s-idle/message": {
        body: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Hello from idle", synthetic: false, ignored: false }],
          },
        ],
      },
    });
    botModule.dispatchEvent({
      payload: {
        type: "session.idle",
        properties: { sessionID: "s-idle" },
      },
    });
    await flushPromises();
    const [chatId, text] = mockBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(902);
    expect(text).toBe("Hello from idle");
  });

  test("session.error dispatches to correct chatId", async () => {
    botModule.sessionToChat.set("s-err", 903);
    botModule.dispatchEvent({
      payload: {
        type: "session.error",
        properties: { sessionID: "s-err", error: { name: "Err", message: "oops" } },
      },
    });
    await flushPromises();
    const [chatId, text] = mockBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(903);
    expect(text).toContain("Err");
  });

  test("unknown event type is silently ignored (no crash)", () => {
    expect(() => {
      botModule.dispatchEvent({
        payload: { type: "unknown.event", properties: {} },
      });
    }).not.toThrow();
  });

  test("event with unknown sessionId is ignored (no handler called)", () => {
    botModule.dispatchEvent({
      payload: { type: "session.idle", properties: { sessionID: "unknown-sess" } },
    });
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  test("event with missing payload is handled safely (no crash)", () => {
    expect(() => botModule.dispatchEvent({})).not.toThrow();
  });

  test("event with null properties is handled safely", () => {
    expect(() =>
      botModule.dispatchEvent({ payload: { type: "session.idle", properties: null } })
    ).not.toThrow();
  });
});
