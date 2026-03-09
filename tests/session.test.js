"use strict";

const { createMockFetch, createMockBot, resetBotState } = require("./helpers/setup");

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const botModule = require("../bot");

let mockBot;

beforeEach(() => {
  resetBotState(botModule);
  mockBot = createMockBot();
  botModule.setBotInstance(mockBot);
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("ensureSession", () => {
  test("creates session if none exists", async () => {
    global.fetch = createMockFetch({
      "/session": { body: { id: "new-sess-1" } },
    });
    const chatId = 201;
    const id = await botModule.ensureSession(chatId);
    expect(id).toBe("new-sess-1");
    expect(botModule.getState(chatId).sessionId).toBe("new-sess-1");
    expect(botModule.sessionToChat.get("new-sess-1")).toBe(chatId);
  });

  test("returns existing session if already set (no createSession call)", async () => {
    global.fetch = createMockFetch();
    const chatId = 202;
    botModule.getState(chatId).sessionId = "existing-sess";
    const id = await botModule.ensureSession(chatId);
    expect(id).toBe("existing-sess");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns the sessionId", async () => {
    global.fetch = createMockFetch({
      "/session": { body: { id: "returned-id" } },
    });
    const id = await botModule.ensureSession(203);
    expect(typeof id).toBe("string");
    expect(id).toBe("returned-id");
  });
});

describe("rehydrateSessions", () => {
  test("registers sessions with matching 'Telegram Chat N' titles", async () => {
    global.fetch = createMockFetch({
      "/session": {
        body: [
          { id: "s-100", title: "Telegram Chat 100", time: { updated: 1000 } },
        ],
      },
    });
    await botModule.rehydrateSessions();
    expect(botModule.sessionToChat.get("s-100")).toBe(100);
    expect(botModule.getState(100).sessionId).toBe("s-100");
  });

  test("ignores sessions without matching title format", async () => {
    global.fetch = createMockFetch({
      "/session": {
        body: [{ id: "s-x", title: "My Custom Session", time: { updated: 1 } }],
      },
    });
    await botModule.rehydrateSessions();
    expect(botModule.sessionToChat.has("s-x")).toBe(false);
  });

  test("handles negative chatIds (Telegram groups)", async () => {
    global.fetch = createMockFetch({
      "/session": {
        body: [
          { id: "s-neg", title: "Telegram Chat -456", time: { updated: 1 } },
        ],
      },
    });
    await botModule.rehydrateSessions();
    expect(botModule.sessionToChat.get("s-neg")).toBe(-456);
  });

  test("picks the newest session when multiple exist for same chatId", async () => {
    global.fetch = createMockFetch({
      "/session": {
        body: [
          { id: "old-sess", title: "Telegram Chat 100", time: { updated: 1000 } },
          { id: "new-sess", title: "Telegram Chat 100", time: { updated: 2000 } },
        ],
      },
    });
    await botModule.rehydrateSessions();
    expect(botModule.getState(100).sessionId).toBe("new-sess");
    // Both sessions mapped
    expect(botModule.sessionToChat.get("old-sess")).toBe(100);
    expect(botModule.sessionToChat.get("new-sess")).toBe(100);
  });

  test("handles empty session list without crash", async () => {
    global.fetch = createMockFetch({ "/session": { body: [] } });
    await expect(botModule.rehydrateSessions()).resolves.not.toThrow();
  });

  test("handles API error gracefully (logs, doesn't throw)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network down"));
    await expect(botModule.rehydrateSessions()).resolves.not.toThrow();
  });

  test("handles non-array response defensively", async () => {
    global.fetch = createMockFetch({ "/session": { body: null } });
    await expect(botModule.rehydrateSessions()).resolves.not.toThrow();
  });
});
