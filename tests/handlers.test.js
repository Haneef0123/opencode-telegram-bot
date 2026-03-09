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
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── handleUserMessage ────────────────────────────────────────────────────────

describe("handleUserMessage", () => {
  test("normal message: sets busy, starts typing, sends prompt", async () => {
    global.fetch = createMockFetch({
      "/session": { body: { id: "sess-nm" } },
      "/session/sess-nm/prompt_async": { body: "" },
    });
    const chatId = 301;
    await botModule.handleUserMessage(chatId, "hello");
    expect(botModule.getState(chatId).busy).toBe(true);
    expect(mockBot.sendChatAction).toHaveBeenCalledWith(chatId, "typing");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/prompt_async"),
      expect.any(Object)
    );
  });

  test("sets busy=true before any async work", async () => {
    let capturedBusy;
    global.fetch = jest.fn().mockImplementation(async () => {
      capturedBusy = botModule.getState(303).busy;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "sess-b" }) };
    });
    await botModule.handleUserMessage(303, "test");
    expect(capturedBusy).toBe(true);
  });

  test("queues message and sends 'Still working' when busy", async () => {
    const chatId = 302;
    const state = botModule.getState(chatId);
    state.sessionId = "sess-busy";
    state.busy = true;

    global.fetch = createMockFetch();
    await botModule.handleUserMessage(chatId, "queued message");

    expect(state.pendingQueue).toEqual(["queued message"]);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⏳ Still working on the previous request, I'll reply to this next."
    );
  });

  test("multiple messages while busy are all queued in FIFO order", async () => {
    const chatId = 304;
    const state = botModule.getState(chatId);
    state.busy = true;
    state.sessionId = "sess-busy2";

    global.fetch = createMockFetch();
    await botModule.handleUserMessage(chatId, "first");
    await botModule.handleUserMessage(chatId, "second");
    await botModule.handleUserMessage(chatId, "third");

    expect(state.pendingQueue).toEqual(["first", "second", "third"]);
  });

  test("routes to handleCustomQuestionAnswer when questionState is active", async () => {
    const chatId = 305;
    global.fetch = createMockFetch({
      "/question/q-1/reply": { body: "" },
    });
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "q-1",
      questions: [{ question: "What?", options: [], custom: true }],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.handleUserMessage(chatId, "custom answer");
    // Should have called replyQuestion (submitted the answer)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/question/q-1/reply"),
      expect.any(Object)
    );
  });

  test("on session creation failure: sends error and resets busy", async () => {
    const chatId = 306;
    global.fetch = jest.fn().mockRejectedValue(new Error("Network fail"));
    await botModule.handleUserMessage(chatId, "hello");
    expect(botModule.getState(chatId).busy).toBe(false);
    const [sentChatId, sentText] = mockBot.sendMessage.mock.calls[0];
    expect(sentChatId).toBe(chatId);
    expect(sentText).toContain("Failed to send message");
  });
});

// ─── drainQueue ───────────────────────────────────────────────────────────────

describe("drainQueue", () => {
  test("empty queue: does nothing", async () => {
    global.fetch = createMockFetch();
    await botModule.drainQueue(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("non-empty queue: processes first (shifted) message", async () => {
    const chatId = 402;
    global.fetch = createMockFetch({
      "/session": { body: { id: "sD" } },
      "/session/sD/prompt_async": { body: "" },
    });
    const state = botModule.getState(chatId);
    state.pendingQueue.push("first", "second");
    await botModule.drainQueue(chatId);
    // Queue should have first item removed
    expect(state.pendingQueue).toEqual(["second"]);
  });

  test("FIFO: shifts from front", async () => {
    const chatId = 403;
    global.fetch = createMockFetch({
      "/session": { body: { id: "sF" } },
      "/session/sF/prompt_async": { body: "" },
    });
    const state = botModule.getState(chatId);
    state.pendingQueue.push("alpha", "beta", "gamma");
    await botModule.drainQueue(chatId);
    expect(state.pendingQueue[0]).toBe("beta");
  });
});

// ─── handleSessionIdle ────────────────────────────────────────────────────────

describe("handleSessionIdle", () => {
  test("stops typing and sets busy=false", async () => {
    const chatId = 501;
    global.fetch = createMockFetch({
      "/session/si-1/message": { body: [] },
    });
    const state = botModule.getState(chatId);
    state.busy = true;
    state.typingTimer = setTimeout(() => {}, 999999);

    await botModule.handleSessionIdle(chatId, "si-1");

    expect(state.busy).toBe(false);
    expect(state.typingTimer).toBeNull();
  });

  test("clears pendingPermission and questionState defensively", async () => {
    const chatId = 502;
    global.fetch = createMockFetch({
      "/session/si-2/message": { body: [] },
    });
    const state = botModule.getState(chatId);
    state.pendingPermission = { requestId: "p1", messageId: 1, timer: setTimeout(() => {}, 999) };
    state.questionState = { requestId: "q1", timer: setTimeout(() => {}, 999) };

    await botModule.handleSessionIdle(chatId, "si-2");

    expect(state.pendingPermission).toBeNull();
    expect(state.questionState).toBeNull();
  });

  test("fetches and sends last assistant text", async () => {
    const chatId = 503;
    global.fetch = createMockFetch({
      "/session/si-3/message": {
        body: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Hello!", synthetic: false, ignored: false }],
          },
        ],
      },
    });

    await botModule.handleSessionIdle(chatId, "si-3");

    expect(mockBot.sendMessage).toHaveBeenCalledWith(503, "Hello!", {});
  });

  test("sends '(no response)' when no assistant text", async () => {
    const chatId = 504;
    global.fetch = createMockFetch({
      "/session/si-4/message": { body: [] },
    });

    await botModule.handleSessionIdle(chatId, "si-4");

    const [sentChatId, sentText] = mockBot.sendMessage.mock.calls[0];
    expect(sentChatId).toBe(chatId);
    expect(sentText).toBe("_(no response)_");
  });

  test("drains queue after sending response", async () => {
    const chatId = 505;
    global.fetch = createMockFetch({
      "/session/si-5/message": {
        body: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Done!", synthetic: false, ignored: false }],
          },
        ],
      },
      "/session": { body: { id: "new-sess-drain" } },
      "/session/new-sess-drain/prompt_async": { body: "" },
    });
    const state = botModule.getState(chatId);
    state.pendingQueue.push("next message");

    await botModule.handleSessionIdle(chatId, "si-5");

    // Queue message should be consumed
    expect(state.pendingQueue.length).toBe(0);
  });
});

// ─── handleSessionError ───────────────────────────────────────────────────────

describe("handleSessionError", () => {
  test("sends formatted error message and drains queue", async () => {
    const chatId = 601;
    global.fetch = createMockFetch();
    const state = botModule.getState(chatId);
    state.busy = true;

    await botModule.handleSessionError(chatId, {
      name: "SessionError",
      message: "Something went wrong",
    });

    expect(state.busy).toBe(false);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "❌ *SessionError*: Something went wrong",
      { parse_mode: "Markdown" }
    );
  });

  test("handles error with data.message over top-level message", async () => {
    const chatId = 602;
    global.fetch = createMockFetch();
    await botModule.handleSessionError(chatId, {
      name: "ApiError",
      data: { message: "API-level error" },
      message: "generic",
    });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "❌ *ApiError*: API-level error",
      { parse_mode: "Markdown" }
    );
  });
});
