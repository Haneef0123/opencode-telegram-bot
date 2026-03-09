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

// ─── handleQuestionAsked ──────────────────────────────────────────────────────

describe("handleQuestionAsked", () => {
  test("single question with options: shows inline keyboard", async () => {
    const chatId = 800;
    const req = {
      id: "q-1",
      questions: [
        { question: "Choose one", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    };
    await botModule.handleQuestionAsked(chatId, req);

    const [, , opts] = mockBot.sendMessage.mock.calls[0];
    expect(opts.reply_markup.inline_keyboard).toHaveLength(2);
  });

  test("single question without options: shows free-text prompt (no keyboard)", async () => {
    const chatId = 801;
    const req = {
      id: "q-2",
      questions: [{ question: "What is your name?", options: [] }],
    };
    await botModule.handleQuestionAsked(chatId, req);

    const [, , opts] = mockBot.sendMessage.mock.calls[0];
    expect(opts.reply_markup).toBeUndefined();
  });

  test("multiple questions: shows first question with '1 of N' prefix", async () => {
    const chatId = 802;
    const req = {
      id: "q-3",
      questions: [
        { question: "First?", options: [] },
        { question: "Second?", options: [] },
      ],
    };
    await botModule.handleQuestionAsked(chatId, req);

    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("1 of 2");
    expect(text).toContain("First?");
  });

  test("empty questions array: rejects immediately without crashing", async () => {
    global.fetch = createMockFetch({
      "/question/q-empty/reject": { body: "" },
    });
    const chatId = 803;
    const req = { id: "q-empty", questions: [] };
    await botModule.handleQuestionAsked(chatId, req);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/question/q-empty/reject"),
      expect.any(Object)
    );
  });

  test("clears previous questionState when new one arrives", async () => {
    const chatId = 804;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "old-q",
      timer: setTimeout(() => {}, 999999),
      questions: [],
      answers: [],
      currentIdx: 0,
    };
    const req = {
      id: "new-q",
      questions: [{ question: "New q?", options: [] }],
    };
    await botModule.handleQuestionAsked(chatId, req);
    expect(state.questionState.requestId).toBe("new-q");
  });
});

// ─── askCurrentQuestion ───────────────────────────────────────────────────────

describe("askCurrentQuestion", () => {
  test("shows 'Question X of Y' for multi-question", async () => {
    const chatId = 810;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "mq",
      questions: [
        { question: "Q1?", options: [] },
        { question: "Q2?", options: [] },
      ],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.askCurrentQuestion(chatId);
    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("1 of 2");
  });

  test("no prefix for single question", async () => {
    const chatId = 811;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "sq",
      questions: [{ question: "Solo?", options: [] }],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.askCurrentQuestion(chatId);
    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).not.toContain("1 of 1");
    expect(text).toBe("Solo?");
  });

  test("shows 'Or type your own answer' footer when custom !== false", async () => {
    const chatId = 812;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "cq",
      questions: [
        { question: "Pick?", options: [{ label: "A" }], custom: true },
      ],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.askCurrentQuestion(chatId);
    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("Or type your own answer");
  });

  test("no footer when custom === false", async () => {
    const chatId = 813;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "fq",
      questions: [
        { question: "Strict?", options: [{ label: "A" }], custom: false },
      ],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.askCurrentQuestion(chatId);
    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).not.toContain("Or type your own answer");
  });
});

// ─── handleCustomQuestionAnswer ───────────────────────────────────────────────

describe("handleCustomQuestionAnswer", () => {
  test("advances when custom is allowed", async () => {
    global.fetch = createMockFetch({
      "/question/cqa-1/reply": { body: "" },
    });
    const chatId = 820;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "cqa-1",
      questions: [{ question: "Q?", options: [], custom: true }],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.handleCustomQuestionAnswer(chatId, "my custom answer");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/question/cqa-1/reply"),
      expect.any(Object)
    );
  });

  test("rejects with 'choose one of the options' when custom is false", async () => {
    const chatId = 821;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "cqa-2",
      questions: [{ question: "Strict Q?", options: [{ label: "X" }], custom: false }],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.handleCustomQuestionAnswer(chatId, "my answer");
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "Please choose one of the options above."
    );
  });
});

// ─── advanceQuestionAnswer ────────────────────────────────────────────────────

describe("advanceQuestionAnswer", () => {
  test("records answer as [label] (array of arrays format)", async () => {
    global.fetch = createMockFetch({ "/question/aq-1/reply": { body: "" } });
    const chatId = 830;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "aq-1",
      questions: [{ question: "Q?", options: [], custom: true }],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.advanceQuestionAnswer(chatId, "chosen label");
    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body).answers).toEqual([["chosen label"]]);
  });

  test("advances to next question in multi-question flow", async () => {
    const chatId = 831;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "aq-2",
      questions: [
        { question: "Q1?", options: [], custom: true },
        { question: "Q2?", options: [], custom: true },
      ],
      answers: [],
      currentIdx: 0,
      timer: null,
    };
    await botModule.advanceQuestionAnswer(chatId, "answer1");
    expect(state.questionState.currentIdx).toBe(1);
    // Now it should ask Q2
    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("Q2?");
  });

  test("submits all answers on last question", async () => {
    global.fetch = createMockFetch({ "/question/aq-3/reply": { body: "" } });
    const chatId = 832;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "aq-3",
      questions: [{ question: "Last Q?", options: [], custom: true }],
      answers: [],
      currentIdx: 0,
      timer: setTimeout(() => {}, 999999),
    };
    await botModule.advanceQuestionAnswer(chatId, "final answer");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/question/aq-3/reply"),
      expect.any(Object)
    );
  });

  test("clears timer and questionState after submission", async () => {
    global.fetch = createMockFetch({ "/question/aq-4/reply": { body: "" } });
    const chatId = 833;
    const state = botModule.getState(chatId);
    state.questionState = {
      requestId: "aq-4",
      questions: [{ question: "Q?", options: [] }],
      answers: [],
      currentIdx: 0,
      timer: setTimeout(() => {}, 999999),
    };
    await botModule.advanceQuestionAnswer(chatId, "done");
    expect(state.questionState).toBeNull();
  });
});

// ─── Question timeout ─────────────────────────────────────────────────────────

describe("Question timeout", () => {
  test("question times out and auto-rejects after INTERACTION_TIMEOUT_MS", async () => {
    global.fetch = createMockFetch({ "/question/q-tout/reject": { body: "" } });
    const chatId = 840;
    const req = {
      id: "q-tout",
      questions: [{ question: "Timed Q?", options: [] }],
    };
    await botModule.handleQuestionAsked(chatId, req);

    jest.advanceTimersByTime(botModule.INTERACTION_TIMEOUT_MS);
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/question/q-tout/reject"),
      expect.any(Object)
    );
  });
});
