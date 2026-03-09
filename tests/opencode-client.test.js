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

describe("ocFetch", () => {
  test("sends correct URL: OPENCODE_URL + path", async () => {
    global.fetch = createMockFetch({ "/session": { body: [] } });
    await botModule.ocFetch("GET", "/session");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/session"),
      expect.any(Object)
    );
  });

  test("includes Content-Type: application/json header", async () => {
    global.fetch = createMockFetch({ "/session": { body: [] } });
    await botModule.ocFetch("GET", "/session");
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  test("sends JSON body for POST", async () => {
    global.fetch = createMockFetch({ "/session": { body: { id: "s1" } } });
    await botModule.ocFetch("POST", "/session", { title: "Test" });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.body).toBe(JSON.stringify({ title: "Test" }));
  });

  test("sends no body for GET", async () => {
    global.fetch = createMockFetch({ "/session": { body: [] } });
    await botModule.ocFetch("GET", "/session");
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  test("returns parsed JSON on success", async () => {
    global.fetch = createMockFetch({ "/session": { body: [{ id: "abc" }] } });
    const result = await botModule.ocFetch("GET", "/session");
    expect(result).toEqual([{ id: "abc" }]);
  });

  test("returns raw text when JSON parse fails", async () => {
    global.fetch = createMockFetch({ "/session": { body: "not-json" } });
    const result = await botModule.ocFetch("GET", "/session");
    expect(result).toBe("not-json");
  });

  test("throws on non-OK status", async () => {
    global.fetch = createMockFetch({
      "/session": { ok: false, status: 500, body: "Server Error" },
    });
    await expect(botModule.ocFetch("GET", "/session")).rejects.toThrow(
      "OpenCode 500: Server Error"
    );
  });
});

describe("createSession", () => {
  test("sends correct payload with chatId", async () => {
    global.fetch = createMockFetch({ "/session": { body: { id: "sess-42" } } });
    await botModule.createSession(12345);
    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ title: "Telegram Chat 12345" });
  });

  test("returns session.id from response", async () => {
    global.fetch = createMockFetch({ "/session": { body: { id: "sess-99" } } });
    const id = await botModule.createSession(99);
    expect(id).toBe("sess-99");
  });
});

describe("sendPromptAsync", () => {
  test("sends correct payload with text parts", async () => {
    global.fetch = createMockFetch({
      "/session/s1/prompt_async": { body: "" },
    });
    await botModule.sendPromptAsync("s1", "hello world");
    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      parts: [{ type: "text", text: "hello world" }],
    });
  });
});

describe("replyPermission", () => {
  test("POSTs to correct path with reply payload", async () => {
    global.fetch = createMockFetch({
      "/permission/perm-1/reply": { body: "" },
    });
    await botModule.replyPermission("perm-1", "once");
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("/permission/perm-1/reply");
    expect(JSON.parse(opts.body)).toEqual({ reply: "once" });
  });
});

describe("replyQuestion", () => {
  test("POSTs answers in correct format", async () => {
    global.fetch = createMockFetch({
      "/question/q-1/reply": { body: "" },
    });
    await botModule.replyQuestion("q-1", [["yes"], ["no"]]);
    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ answers: [["yes"], ["no"]] });
  });
});

describe("fetchLastAssistantText", () => {
  test("returns joined text of last assistant message, excluding synthetic/ignored parts", async () => {
    global.fetch = createMockFetch({
      "/session/sess1/message": {
        body: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "hello" }],
          },
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "Part 1. ", synthetic: false, ignored: false },
              { type: "text", text: "Part 2.", synthetic: false, ignored: false },
              { type: "text", text: "IGNORED", synthetic: true, ignored: false },
              { type: "text", text: "ALSO IGNORED", synthetic: false, ignored: true },
            ],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Latest reply.", synthetic: false, ignored: false }],
          },
        ],
      },
    });
    const result = await botModule.fetchLastAssistantText("sess1");
    expect(result).toBe("Latest reply.");
  });

  test("returns null when no assistant messages", async () => {
    global.fetch = createMockFetch({
      "/session/sess2/message": {
        body: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
      },
    });
    const result = await botModule.fetchLastAssistantText("sess2");
    expect(result).toBeNull();
  });

  test("returns null when text is empty/whitespace after filtering", async () => {
    global.fetch = createMockFetch({
      "/session/sess3/message": {
        body: [
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "  ", synthetic: false, ignored: false },
            ],
          },
        ],
      },
    });
    const result = await botModule.fetchLastAssistantText("sess3");
    expect(result).toBeNull();
  });

  test("returns null when messages array is empty", async () => {
    global.fetch = createMockFetch({
      "/session/sess4/message": { body: [] },
    });
    const result = await botModule.fetchLastAssistantText("sess4");
    expect(result).toBeNull();
  });
});
