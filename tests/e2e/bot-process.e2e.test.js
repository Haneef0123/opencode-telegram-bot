"use strict";

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceServerListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

class FakeOpenCodeServer {
  constructor() {
    this.server = http.createServer(this._handle.bind(this));
    this.sseClients = new Set();
    this.sseConnectionCount = 0;

    this.sessionCounter = 0;
    this.permissionCounter = 0;
    this.questionCounter = 0;

    this.sessions = new Map();
    this.pendingPermission = new Map();
    this.pendingQuestion = new Map();

    this.promptCalls = [];
    this.abortCalls = [];
    this.permissionReplies = [];
    this.questionReplies = [];
    this.questionRejects = [];
  }

  get baseUrl() {
    const addr = this.server.address();
    return `http://127.0.0.1:${addr.port}`;
  }

  async start() {
    await onceServerListening(this.server);
  }

  async stop() {
    this.closeSseClients();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  closeSseClients() {
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {}
    }
    this.sseClients.clear();
  }

  addSession({ id, title, updated, messages = [] }) {
    const sessionId = id || `sess-${++this.sessionCounter}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      title,
      time: { updated: updated || Date.now() },
      messages: Array.isArray(messages) ? messages : [],
      badMessages: false,
      waitingAbort: false,
    });
    return sessionId;
  }

  appendAssistantText(sessionId, text) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.messages.push({
      info: { role: "assistant" },
      parts: [{ type: "text", text, synthetic: false, ignored: false }],
    });
    s.time.updated = Date.now();
  }

  emitEvent(type, properties) {
    const event = { payload: { type, properties } };
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(line);
      } catch {}
    }
  }

  _scenarioFromText(text = "") {
    const patterns = [
      "E2E:QUEUE_SLOW",
      "E2E:QUEUE_FAST",
      "E2E:PERM_APPROVE",
      "E2E:PERM_TIMEOUT",
      "E2E:QUESTION_OPTION",
      "E2E:QUESTION_CUSTOM",
      "E2E:QUESTION_TIMEOUT",
      "E2E:QUESTION_INVALID",
      "E2E:ABORT_WAIT",
      "E2E:ERROR",
      "E2E:NO_RESPONSE",
      "E2E:BAD_MESSAGES",
      "E2E:LONG",
    ];
    for (const p of patterns) {
      if (text.includes(p)) return p;
    }
    return "E2E:ECHO";
  }

  _ensureSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        title: `Telegram Chat ${sessionId}`,
        time: { updated: Date.now() },
        messages: [],
        badMessages: false,
        waitingAbort: false,
      });
    }
    return this.sessions.get(sessionId);
  }

  async _handlePromptAsync(sessionId, text) {
    const s = this._ensureSession(sessionId);
    s.badMessages = false;
    s.waitingAbort = false;

    const scenario = this._scenarioFromText(text);

    if (scenario === "E2E:QUEUE_SLOW") {
      setTimeout(() => {
        this.appendAssistantText(sessionId, "queue first done");
        this.emitEvent("session.idle", { sessionID: sessionId });
      }, 220);
      return;
    }

    if (scenario === "E2E:QUEUE_FAST") {
      setTimeout(() => {
        this.appendAssistantText(sessionId, "queue second done");
        this.emitEvent("session.idle", { sessionID: sessionId });
      }, 20);
      return;
    }

    if (scenario === "E2E:PERM_APPROVE" || scenario === "E2E:PERM_TIMEOUT") {
      const requestId = `perm-${++this.permissionCounter}`;
      this.pendingPermission.set(requestId, { sessionId });
      this.emitEvent("permission.asked", {
        sessionID: sessionId,
        id: requestId,
        permission: "shell.execute",
        metadata: {
          command: "echo e2e",
          path: "/tmp/e2e",
          description: "E2E permission check",
        },
      });
      return;
    }

    if (
      scenario === "E2E:QUESTION_OPTION" ||
      scenario === "E2E:QUESTION_CUSTOM" ||
      scenario === "E2E:QUESTION_TIMEOUT" ||
      scenario === "E2E:QUESTION_INVALID"
    ) {
      const requestId = `q-${++this.questionCounter}`;
      this.pendingQuestion.set(requestId, { sessionId, scenario });

      let questions;
      if (scenario === "E2E:QUESTION_CUSTOM") {
        questions = [{ question: "Provide custom answer", options: [], custom: true }];
      } else if (scenario === "E2E:QUESTION_TIMEOUT") {
        questions = [{ question: "Timeout question", options: [{ label: "X" }], custom: false }];
      } else if (scenario === "E2E:QUESTION_INVALID") {
        questions = [{ question: "Pick exactly one", options: [{ label: "Only" }], custom: false }];
      } else {
        questions = [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }], custom: false }];
      }

      this.emitEvent("question.asked", {
        sessionID: sessionId,
        id: requestId,
        questions,
      });
      return;
    }

    if (scenario === "E2E:ABORT_WAIT") {
      s.waitingAbort = true;
      return;
    }

    if (scenario === "E2E:ERROR") {
      this.emitEvent("session.error", {
        sessionID: sessionId,
        error: { name: "SessionError", message: "Synthetic E2E error" },
      });
      return;
    }

    if (scenario === "E2E:NO_RESPONSE") {
      s.messages = [];
      this.emitEvent("session.idle", { sessionID: sessionId });
      return;
    }

    if (scenario === "E2E:BAD_MESSAGES") {
      s.badMessages = true;
      this.emitEvent("session.idle", { sessionID: sessionId });
      return;
    }

    if (scenario === "E2E:LONG") {
      this.appendAssistantText(sessionId, "L".repeat(5000));
      this.emitEvent("session.idle", { sessionID: sessionId });
      return;
    }

    this.appendAssistantText(sessionId, `Echo: ${text}`);
    this.emitEvent("session.idle", { sessionID: sessionId });
  }

  async _handle(req, res) {
    const url = new URL(req.url, this.baseUrl);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/global/event") {
      this.sseConnectionCount += 1;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
      });
      res.write("\n");
      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/session") {
      return sendJson(res, 200, Array.from(this.sessions.values()));
    }

    if (req.method === "POST" && pathname === "/session") {
      const body = await readJsonBody(req);
      const sessionId = `sess-${++this.sessionCounter}`;
      this.sessions.set(sessionId, {
        id: sessionId,
        title: body.title || "Untitled",
        time: { updated: Date.now() },
        messages: [],
        badMessages: false,
        waitingAbort: false,
      });
      return sendJson(res, 200, { id: sessionId });
    }

    const promptMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === "POST" && promptMatch) {
      const sessionId = promptMatch[1];
      const body = await readJsonBody(req);
      const text = body?.parts?.[0]?.text || "";
      this.promptCalls.push({ sessionId, text });
      await this._handlePromptAsync(sessionId, text);
      return sendJson(res, 200, {});
    }

    const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (req.method === "POST" && abortMatch) {
      const sessionId = abortMatch[1];
      this.abortCalls.push(sessionId);
      this.emitEvent("session.error", {
        sessionID: sessionId,
        error: { name: "Aborted", message: "Aborted by E2E" },
      });
      return sendJson(res, 200, {});
    }

    const messagesMatch = pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && messagesMatch) {
      const sessionId = messagesMatch[1];
      const s = this.sessions.get(sessionId);
      if (!s) return sendJson(res, 200, []);
      if (s.badMessages) return sendJson(res, 200, { invalid: true });
      return sendJson(res, 200, s.messages);
    }

    const permMatch = pathname.match(/^\/permission\/([^/]+)\/reply$/);
    if (req.method === "POST" && permMatch) {
      const requestId = permMatch[1];
      const body = await readJsonBody(req);
      const pending = this.pendingPermission.get(requestId);
      this.permissionReplies.push({ requestId, reply: body.reply });
      if (pending) {
        this.pendingPermission.delete(requestId);
        this.appendAssistantText(pending.sessionId, `Permission reply acknowledged: ${body.reply}`);
        this.emitEvent("session.idle", { sessionID: pending.sessionId });
      }
      return sendJson(res, 200, {});
    }

    const questionReplyMatch = pathname.match(/^\/question\/([^/]+)\/reply$/);
    if (req.method === "POST" && questionReplyMatch) {
      const requestId = questionReplyMatch[1];
      const body = await readJsonBody(req);
      const pending = this.pendingQuestion.get(requestId);
      this.questionReplies.push({ requestId, answers: body.answers });
      if (pending) {
        this.pendingQuestion.delete(requestId);
        this.appendAssistantText(
          pending.sessionId,
          `Question answers received: ${JSON.stringify(body.answers)}`
        );
        this.emitEvent("session.idle", { sessionID: pending.sessionId });
      }
      return sendJson(res, 200, {});
    }

    const questionRejectMatch = pathname.match(/^\/question\/([^/]+)\/reject$/);
    if (req.method === "POST" && questionRejectMatch) {
      const requestId = questionRejectMatch[1];
      const pending = this.pendingQuestion.get(requestId);
      this.questionRejects.push({ requestId });
      if (pending) {
        this.pendingQuestion.delete(requestId);
        this.appendAssistantText(pending.sessionId, `Question rejected: ${requestId}`);
        this.emitEvent("session.idle", { sessionID: pending.sessionId });
      }
      return sendJson(res, 200, {});
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }
}

class BotProcessHarness {
  constructor(server) {
    this.server = server;
    this.child = null;
    this.telegramEvents = [];
    this.stdout = [];
    this.stderr = [];
    this.nextIncomingMessageId = 10;
    this.nextCallbackId = 1;
  }

  async start() {
    const loaderPath = path.join(
      "/Users/haneefshaikh/opencode-telegram-bot",
      "tests/e2e/fixtures/mock-telegram-loader.js"
    );

    const env = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "e2e-token",
      OPENCODE_SERVER_URL: this.server.baseUrl,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${loaderPath}`.trim(),
    };

    this.child = spawn(process.execPath, ["bot.js"], {
      cwd: "/Users/haneefshaikh/opencode-telegram-bot",
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    this.child.stdout.on("data", (buf) => {
      this.stdout.push(buf.toString("utf8"));
    });

    this.child.stderr.on("data", (buf) => {
      this.stderr.push(buf.toString("utf8"));
    });

    this.child.on("message", (msg) => {
      if (msg && msg.__channel === "mock-telegram") {
        this.telegramEvents.push(msg);
      }
    });

    await this.waitFor(() => this.stdout.join("").includes("[SSE] Connected."), 5000);
  }

  async stop() {
    if (!this.child) return;

    this.child.kill("SIGINT");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 2000);

      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(20);
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms.\nstdout:\n${this.stdout.join("")}\nstderr:\n${this.stderr.join("")}`
    );
  }

  async waitForTelegramEvent(predicate, timeoutMs = 3000, fromIndex = 0) {
    return this.waitFor(() => {
      for (let i = fromIndex; i < this.telegramEvents.length; i += 1) {
        const evt = this.telegramEvents[i];
        if (predicate(evt)) return { evt, index: i };
      }
      return null;
    }, timeoutMs);
  }

  sendUserMessage(chatId, text) {
    this.child.send({
      __channel: "mock-telegram",
      type: "emitMessage",
      payload: {
        chatId,
        text,
        message_id: ++this.nextIncomingMessageId,
      },
    });
  }

  tapCallback(chatId, messageId, data) {
    const callbackId = `cb-${++this.nextCallbackId}`;
    this.child.send({
      __channel: "mock-telegram",
      type: "emitCallback",
      payload: {
        id: callbackId,
        chatId,
        data,
        message_id: messageId,
      },
    });
    return callbackId;
  }
}

async function withHarness(testFn, preseed) {
  const server = new FakeOpenCodeServer();
  await server.start();

  if (typeof preseed === "function") {
    preseed(server);
  }

  const harness = new BotProcessHarness(server);

  try {
    await harness.start();
    await testFn({ harness, server });
  } finally {
    await harness.stop();
    await server.stop();
  }
}

jest.setTimeout(60000);

describe("bot.js process E2E", () => {
  const chatId = 99001;

  test("commands and session lifecycle flows", async () => {
    await withHarness(async ({ harness, server }) => {
      harness.sendUserMessage(chatId, "/help");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("OpenCode Telegram Bot"),
        4000
      );

      harness.sendUserMessage(chatId, "/start");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Connected to OpenCode"),
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:ECHO] hello world");
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("Echo:"),
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:LONG]");
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.length === 4096,
        5000
      );
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.length === 904,
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:NO_RESPONSE]");
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text === "_(no response)_",
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:BAD_MESSAGES]");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("could not retrieve the response"),
        5000
      );

      harness.sendUserMessage(chatId, "/abort");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Nothing is running right now"),
        3000
      );

      harness.sendUserMessage(chatId, "[E2E:ABORT_WAIT]");
      harness.sendUserMessage(chatId, "/abort");
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("Aborted."),
        5000
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("*Aborted*: Aborted by E2E"),
        5000
      );

      expect(server.abortCalls.length).toBeGreaterThan(0);
    });
  });

  test("queue, permissions, questions, and callback paths", async () => {
    await withHarness(async ({ harness, server }) => {
      harness.sendUserMessage(chatId, "/start");
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("Connected"),
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:QUEUE_SLOW]");
      harness.sendUserMessage(chatId, "[E2E:QUEUE_FAST]");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Still working on the previous request"),
        5000
      );
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("queue first done"),
        5000
      );
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("queue second done"),
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:PERM_APPROVE]");
      const permPrompt = await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Permission Request") &&
          e.payload.opts?.reply_markup?.inline_keyboard,
        5000
      );
      const onceCallbackData = permPrompt.evt.payload.opts.reply_markup.inline_keyboard[0][0].callback_data;
      const callbackId = harness.tapCallback(chatId, permPrompt.evt.payload.message_id, onceCallbackData);

      await harness.waitForTelegramEvent(
        (e) => e.type === "answerCallbackQuery" && e.payload.id === callbackId,
        3000,
        permPrompt.index
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("Allowed (once)"),
        5000,
        permPrompt.index
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Permission reply acknowledged: once"),
        5000,
        permPrompt.index
      );

      expect(server.permissionReplies.some((r) => r.reply === "once")).toBe(true);

      harness.sendUserMessage(chatId, "[E2E:PERM_TIMEOUT]");
      const permTimeoutStart = harness.telegramEvents.length;
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Permission Request"),
        5000,
        permTimeoutStart
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("timed out") &&
          e.payload.text.includes("denied automatically"),
        5000,
        permTimeoutStart
      );
      await harness.waitFor(() => server.permissionReplies.some((r) => r.reply === "reject"), 5000);

      harness.sendUserMessage(chatId, "[E2E:QUESTION_OPTION]");
      const questionPrompt = await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Pick one") &&
          e.payload.opts?.reply_markup?.inline_keyboard,
        5000
      );
      const pickBData = questionPrompt.evt.payload.opts.reply_markup.inline_keyboard[1][0].callback_data;
      const questionCallbackId = harness.tapCallback(
        chatId,
        questionPrompt.evt.payload.message_id,
        pickBData
      );

      await harness.waitForTelegramEvent(
        (e) => e.type === "answerCallbackQuery" && e.payload.id === questionCallbackId,
        3000,
        questionPrompt.index
      );
      await harness.waitForTelegramEvent(
        (e) => e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("Selected: *B*"),
        5000,
        questionPrompt.index
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Question answers received"),
        5000,
        questionPrompt.index
      );

      expect(
        server.questionReplies.some(
          (r) => Array.isArray(r.answers) && Array.isArray(r.answers[0]) && r.answers[0][0] === "B"
        )
      ).toBe(true);

      harness.sendUserMessage(chatId, "[E2E:QUESTION_CUSTOM]");
      const customPrompt = await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Provide custom answer"),
        5000
      );
      harness.sendUserMessage(chatId, "my custom answer");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Answers submitted, continuing"),
        5000,
        customPrompt.index
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("my custom answer"),
        5000,
        customPrompt.index
      );

      harness.sendUserMessage(chatId, "[E2E:QUESTION_INVALID]");
      const invalidPrompt = await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Pick exactly one") &&
          e.payload.opts?.reply_markup?.inline_keyboard,
        5000
      );
      const validData = invalidPrompt.evt.payload.opts.reply_markup.inline_keyboard[0][0].callback_data;
      const invalidData = validData.replace(/:0$/, ":99");
      harness.tapCallback(chatId, invalidPrompt.evt.payload.message_id, invalidData);
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Invalid option selected"),
        5000,
        invalidPrompt.index
      );

      harness.sendUserMessage(chatId, "/new");
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Started a fresh session"),
        5000
      );

      harness.sendUserMessage(chatId, "[E2E:QUESTION_TIMEOUT]");
      const timeoutPromptIndex = harness.telegramEvents.length;
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Timeout question"),
        5000,
        timeoutPromptIndex
      );
      await harness.waitForTelegramEvent(
        (e) =>
          e.type === "sendMessage" &&
          e.payload.chatId === chatId &&
          e.payload.text.includes("Question timed out"),
        5000,
        timeoutPromptIndex
      );
      expect(server.questionRejects.length).toBeGreaterThan(0);
    });
  });

  test("rehydration and SSE reconnect", async () => {
    await withHarness(
      async ({ harness, server }) => {
        const rehydratedSession = "rehyd-1";
        server.appendAssistantText(rehydratedSession, "rehydrated hello");
        server.emitEvent("session.idle", { sessionID: rehydratedSession });

        await harness.waitForTelegramEvent(
          (e) =>
            e.type === "sendMessage" && e.payload.chatId === chatId && e.payload.text.includes("rehydrated hello"),
          5000
        );

        const beforeReconnectCount = server.sseConnectionCount;
        server.closeSseClients();
        await harness.waitFor(() => server.sseConnectionCount > beforeReconnectCount, 5000);

        harness.sendUserMessage(chatId, "[E2E:ECHO] after reconnect");
        await harness.waitForTelegramEvent(
          (e) =>
            e.type === "sendMessage" &&
            e.payload.chatId === chatId &&
            e.payload.text.includes("Echo: [E2E:ECHO] after reconnect"),
          5000
        );

        server.emitEvent("unknown.event", { sessionID: rehydratedSession });
        await sleep(120);
        expect(harness.child.exitCode).toBeNull();
      },
      (server) => {
        server.addSession({
          id: "rehyd-1",
          title: `Telegram Chat ${chatId}`,
          updated: Date.now(),
          messages: [],
        });
      }
    );
  });
});
