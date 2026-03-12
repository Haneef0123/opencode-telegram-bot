"use strict";

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const projectRoot = process.env.PROJECT_ROOT || process.cwd();
require("dotenv").config({ path: path.join(projectRoot, ".env") });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceListening(server) {
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
    await onceListening(this.server);
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
      }, 800);
      return;
    }

    if (scenario === "E2E:QUEUE_FAST") {
      setTimeout(() => {
        this.appendAssistantText(sessionId, "queue second done");
        this.emitEvent("session.idle", { sessionID: sessionId });
      }, 120);
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
          command: "echo e2e-live",
          path: "/tmp/e2e-live",
          description: "Live E2E permission check",
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
      this.pendingQuestion.set(requestId, { sessionId });

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

    // Provider list — used by the /model command
    if (req.method === "GET" && pathname === "/provider") {
      return sendJson(res, 200, {
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: [
              { id: "claude-opus-4-5",    name: "Claude Opus 4.5" },
              { id: "claude-sonnet-4-5",  name: "Claude Sonnet 4.5" },
              { id: "claude-haiku-4-5",   name: "Claude Haiku 4.5" },
            ],
          },
          {
            id: "openai",
            name: "OpenAI",
            models: [
              { id: "gpt-4o",       name: "GPT-4o" },
              { id: "gpt-4o-mini",  name: "GPT-4o Mini" },
            ],
          },
        ],
        connected: ["anthropic", "openai"],
        default: { provider: "anthropic", model: "claude-sonnet-4-5" },
      });
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

class BotProcess {
  constructor(openCodeUrl) {
    this.openCodeUrl = openCodeUrl;
    this.child = null;
    this.stdout = "";
    this.stderr = "";
  }

  async start() {
    const loaderPath = path.join(projectRoot, "skills/telegram-live-e2e/scripts/live-timeout-loader.js");

    this.child = spawn(process.execPath, ["bot.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        OPENCODE_SERVER_URL: this.openCodeUrl,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: "",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${loaderPath}`.trim(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (buf) => {
      this.stdout += buf.toString("utf8");
    });

    this.child.stderr.on("data", (buf) => {
      this.stderr += buf.toString("utf8");
    });

    await this.waitFor(() => this.stdout.includes("[SSE] Connected."), 20000, "bot startup");
  }

  async stop() {
    if (!this.child) return;

    this.child.kill("SIGINT");
    await new Promise((resolve) => {
      // Give it 1.5s to exit gracefully, then force-kill
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
        resolve();
      }, 1500);

      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    // Short pause to let Telegram's server register the polling connection closed
    await sleep(2000);
  }

  async waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(100);
    }
    throw new Error(`Timeout waiting for ${label}. stdout=${this.stdout} stderr=${this.stderr}`);
  }
}

async function fetchBotUsername(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`getMe failed: ${json.description}`);
  }
  return json.result.username;
}

/**
 * Forcefully terminates any competing polling session.
 * Strategy:
 * 1. deleteWebhook to clear webhooks
 * 2. Call getUpdates with timeout=0 several times to claim + immediately
 *    release the polling slot, which evicts any competing long-poll
 * 3. Wait for Telegram server to propagate
 */
async function clearPollingConflict(token) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
  } catch {}
  // Claim & release the getUpdates slot a few times to evict competing bots
  for (let i = 0; i < 3; i++) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=1`);
    } catch {}
    await sleep(500);
  }
  // Give Telegram time to register the new state
  await sleep(4000);
}

async function waitIncoming(client, entity, afterId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(entity, { limit: 40 });
    const incoming = messages
      .filter((m) => !m.out && typeof m.id === "number" && m.id > afterId)
      .sort((a, b) => a.id - b.id);

    for (const message of incoming) {
      const text = (message.message || "").trim();
      if (predicate(message, text)) {
        return message;
      }
    }

    await sleep(1200);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function normalize(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function clickButton(message, row, col) {
  if (typeof message.click !== "function") {
    throw new Error("Message click() is unavailable");
  }
  await message.click({ i: row, j: col });
}

async function main() {
  const required = ["TG_API_ID", "TG_API_HASH", "TG_STRING_SESSION", "TELEGRAM_BOT_TOKEN"];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing env ${key}`);
    }
  }

  const runId = Date.now();
  const tag = `[LIVE-E2E-${runId}]`;
  const report = {
    runId,
    tag,
    startedAt: new Date().toISOString(),
    steps: [],
    notes: [],
  };

  const server = new FakeOpenCodeServer();
  const botUsername = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);

  const client = new TelegramClient(
    new StringSession(process.env.TG_STRING_SESSION),
    Number(process.env.TG_API_ID),
    process.env.TG_API_HASH,
    { connectionRetries: 5 }
  );

  let botProcess = null;

  async function recordStep(name, fn) {
    const start = Date.now();
    try {
      const details = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - start, details: details || null });
    } catch (err) {
      report.steps.push({ name, ok: false, ms: Date.now() - start, error: err.message });
      throw err;
    }
  }

  try {
    await server.start();

    await client.connect();
    const entity = await client.getEntity(botUsername);
    const chatId = Number(entity.id);

    server.addSession({ id: `rehyd-${chatId}`, title: `Telegram Chat ${chatId}`, updated: Date.now() - 10000 });

    // Clear any competing polling session before starting the test bot
    await clearPollingConflict(process.env.TELEGRAM_BOT_TOKEN);

    botProcess = new BotProcess(server.baseUrl);
    await botProcess.start();

    if (botProcess.stderr.includes("409 Conflict")) {
      throw new Error("Telegram polling conflict detected (another instance is running for the same bot token)");
    }

    async function sendText(text) {
      return client.sendMessage(entity, { message: text });
    }

    async function expectReply(afterId, label, matcher, timeoutMs = 30000) {
      return waitIncoming(
        client,
        entity,
        afterId,
        (message, txt) => matcher(message, normalize(txt)),
        timeoutMs,
        label
      );
    }

    await recordStep("/help", async () => {
      const sent = await sendText("/help");
      const msg = await expectReply(sent.id, "help", (_, txt) => txt.includes("OpenCode Telegram Bot"));
      return { replyId: msg.id, preview: normalize(msg.message).slice(0, 120) };
    });

    await recordStep("/start", async () => {
      const sent = await sendText("/start");
      const msg = await expectReply(
        sent.id,
        "start",
        (_, txt) => txt.includes("Connected to OpenCode") || txt.includes("Already connected")
      );
      return { replyId: msg.id, preview: normalize(msg.message) };
    });

    await recordStep("/new", async () => {
      const sent = await sendText("/new");
      const msg = await expectReply(sent.id, "new", (_, txt) => txt.includes("Started a fresh session"));
      return { replyId: msg.id };
    });

    // ── /model pagination tests ───────────────────────────────────────────────
    // The fake server exposes: Anthropic (3 models) and OpenAI (2 models),
    // both in the "connected" list, with default anthropic/claude-sonnet-4-5.
    // With MODELS_PER_PAGE=8 there is only 1 page per provider, so pagination
    // nav buttons won't appear — but provider tab switching will.

    await recordStep("/model picker shown with provider tabs", async () => {
      const sent = await sendText("/model");
      const msg = await expectReply(
        sent.id,
        "model picker",
        (message, txt) =>
          txt.includes("Model Selection") &&
          txt.includes("Current model") &&
          Array.isArray(message.buttons) &&
          message.buttons.length > 0
      );
      // Row 0 must be provider tabs (Anthropic tab marked active with ●)
      const tabRow = msg.buttons && msg.buttons[0];
      if (!tabRow) throw new Error("No tab row found on picker");
      const tabTexts = tabRow.map(b => b.text || "");
      const hasActivTab = tabTexts.some(t => t.startsWith("●"));
      if (!hasActivTab) throw new Error(`No active provider tab (●) found. Tabs: ${tabTexts.join(", ")}`);
      return { msgId: msg.id, tabs: tabTexts, preview: normalize(msg.message).slice(0, 120) };
    });

    await recordStep("/model — switch provider tab", async () => {
      const sent = await sendText("/model");
      const picker = await expectReply(
        sent.id,
        "model picker for tab switch",
        (message, txt) => txt.includes("Model Selection") && Array.isArray(message.buttons) && message.buttons.length > 0
      );
      // Row 0 = provider tabs. Click the second tab (index 1 = OpenAI in the fake server)
      await clickButton(picker, 0, 1);
      // The picker edits in-place. After the tab switch, row 0 button[0] should
      // show "OpenAI" as inactive (no ●) and button[1] should have ● prefix.
      // We detect the switch by checking that the active tab (● prefix) moved to
      // the second button in the tab row.
      const deadline = Date.now() + 15000;
      let updated = null;
      while (Date.now() < deadline) {
        const msgs = await client.getMessages(entity, { ids: [picker.id] });
        const m = msgs && msgs[0];
        if (m && Array.isArray(m.buttons) && m.buttons[0]) {
          const tabRow = m.buttons[0];
          // Active tab (●) should now be on column 1 (OpenAI)
          const activeTab = tabRow.find(b => (b.text || "").startsWith("●"));
          if (activeTab && (activeTab.text || "").includes("OpenAI")) {
            updated = m;
            break;
          }
        }
        await sleep(800);
      }
      if (!updated) throw new Error("Picker did not switch to OpenAI tab");
      const tabRow = updated.buttons[0].map(b => b.text);
      return { pickerId: picker.id, tabs: tabRow };
    });

    await recordStep("/model — select a model via button", async () => {
      const sent = await sendText("/model");
      const picker = await expectReply(
        sent.id,
        "model picker for selection",
        (message, txt) => txt.includes("Model Selection") && Array.isArray(message.buttons) && message.buttons.length > 0
      );
      // Layout: row 0 = provider tabs, row 1 = separator, row 2 = first model
      // Read the first model button's text so we know what to expect
      const firstModelBtn = picker.buttons && picker.buttons[2] && picker.buttons[2][0];
      if (!firstModelBtn) throw new Error("Could not find first model button at row 2");
      const firstModelName = (firstModelBtn.text || "").replace(" ✓", "").trim();
      // Click row 2, col 0 — first real model
      await clickButton(picker, 2, 0);
      // Wait for the message body to reflect the selection in "Current model:"
      const deadline = Date.now() + 15000;
      let updated = null;
      while (Date.now() < deadline) {
        const msgs = await client.getMessages(entity, { ids: [picker.id] });
        const m = msgs && msgs[0];
        const txt = normalize(m && m.message || "");
        // The selected model ID is now shown in the Current model line
        if (txt.includes("Current model:") && !txt.includes("OpenCode default")) {
          updated = m;
          break;
        }
        await sleep(800);
      }
      if (!updated) throw new Error("Picker message was not updated after model selection");
      return { pickerId: picker.id, selectedBtn: firstModelName, updatedText: normalize(updated.message).slice(0, 120) };
    });

    await recordStep("/model — reset to default", async () => {
      // First, confirm a model is currently selected (from the previous step)
      const sent = await sendText("/model");
      const picker = await expectReply(
        sent.id,
        "model picker for reset",
        (message, txt) => txt.includes("Model Selection") && Array.isArray(message.buttons) && message.buttons.length > 0
      );
      // Capture the current model text before reset
      const beforeTxt = normalize(picker.message || "");
      // Last row = "↩ Use OpenCode default"
      const lastRow = picker.buttons.length - 1;
      await clickButton(picker, lastRow, 0);
      // After reset, the "Current model:" line should revert — either to the
      // resolved server default string or to "OpenCode default" (when default
      // can't be resolved from the fake server)
      const deadline = Date.now() + 15000;
      let updated = null;
      while (Date.now() < deadline) {
        const msgs = await client.getMessages(entity, { ids: [picker.id] });
        const m = msgs && msgs[0];
        const txt = normalize(m && m.message || "");
        // Accept any of: explicit default model string, or "OpenCode default",
        // as long as it's different from the previously selected model text
        const isReset = txt !== beforeTxt &&
          (txt.includes("OpenCode default") || !txt.includes("anthropic/claude-opus-4-5"));
        if (isReset) { updated = m; break; }
        await sleep(800);
      }
      if (!updated) throw new Error("Picker did not reset to default model");
      return { pickerId: picker.id, resetText: normalize(updated.message).slice(0, 120) };
    });

    await recordStep("queue behavior", async () => {
      // Warm up: send a plain echo first so a session already exists and the
      // bot is in idle state before we hit it with the QUEUE_SLOW scenario.
      const warmup = await sendText(`${tag} E2E:ECHO warm`);
      await expectReply(warmup.id, "queue warmup echo", (_, txt) => txt.includes("Echo:") && txt.includes("warm"), 30000);

      const slow = await sendText(`${tag} E2E:QUEUE_SLOW`);
      const fast = await sendText(`${tag} E2E:QUEUE_FAST`);
      await expectReply(fast.id, "queue busy", (_, txt) => txt.includes("Still working on the previous request"), 30000);
      const first = await expectReply(fast.id, "queue first done", (_, txt) => txt.includes("queue first done"), 30000);
      const second = await expectReply(first.id, "queue second done", (_, txt) => txt.includes("queue second done"), 30000);
      return { sent: [slow.id, fast.id], replies: [first.id, second.id] };
    });

    await recordStep("permission approve callback", async () => {
      const sent = await sendText(`${tag} E2E:PERM_APPROVE`);
      const prompt = await expectReply(
        sent.id,
        "permission prompt",
        (message, txt) => txt.includes("Permission Request") && Array.isArray(message.buttons) && message.buttons.length > 0
      );
      await clickButton(prompt, 0, 0);
      await expectReply(prompt.id, "allowed once", (_, txt) => txt.includes("Allowed") && txt.includes("once"));
      const ack = await expectReply(prompt.id, "permission ack", (_, txt) => txt.includes("Permission reply acknowledged: once"));
      return { promptId: prompt.id, ackId: ack.id };
    });

    await recordStep("permission timeout auto-deny", async () => {
      const sent = await sendText(`${tag} E2E:PERM_TIMEOUT`);
      const prompt = await expectReply(sent.id, "permission timeout prompt", (_, txt) => txt.includes("Permission Request"));
      const timeoutMsg = await expectReply(
        prompt.id,
        "permission timeout message",
        (_, txt) => txt.includes("timed out") && txt.includes("denied automatically"),
        20000
      );
      return { promptId: prompt.id, timeoutMsgId: timeoutMsg.id };
    });

    await recordStep("question option callback", async () => {
      const sent = await sendText(`${tag} E2E:QUESTION_OPTION`);
      const prompt = await expectReply(
        sent.id,
        "question option prompt",
        (message, txt) => txt.includes("Pick one") && Array.isArray(message.buttons) && message.buttons.length >= 2
      );
      await clickButton(prompt, 1, 0);
      await expectReply(prompt.id, "selected b", (_, txt) => txt.includes("Selected") && txt.includes("B"), 60000);
      const ack = await expectReply(prompt.id, "question answer ack", (_, txt) => txt.includes("Question answers received"), 60000);
      return { promptId: prompt.id, ackId: ack.id };
    });

    await recordStep("question custom free-text", async () => {
      const sent = await sendText(`${tag} E2E:QUESTION_CUSTOM`);
      const prompt = await expectReply(sent.id, "question custom prompt", (_, txt) => txt.includes("Provide custom answer"));
      const custom = await sendText(`${tag} my custom answer`);
      await expectReply(custom.id, "custom submitted", (_, txt) => txt.includes("Answers submitted, continuing"));
      const ack = await expectReply(custom.id, "custom ack", (_, txt) => txt.includes("my custom answer"));
      return { promptId: prompt.id, ackId: ack.id };
    });

    await recordStep("question custom disallowed guard", async () => {
      const sent = await sendText(`${tag} E2E:QUESTION_INVALID`);
      const prompt = await expectReply(sent.id, "invalid question prompt", (_, txt) => txt.includes("Pick exactly one"));
      const custom = await sendText(`${tag} not allowed custom`);
      const msg = await expectReply(custom.id, "choose options warning", (_, txt) => txt.includes("Please choose one of the options above"), 60000);
      return { promptId: prompt.id, warningId: msg.id };
    });

    await recordStep("question timeout reject", async () => {
      const reset = await sendText("/new");
      await expectReply(reset.id, "new before timeout question", (_, txt) => txt.includes("Started a fresh session"));

      const sent = await sendText(`${tag} E2E:QUESTION_TIMEOUT`);
      const prompt = await expectReply(sent.id, "timeout question prompt", (_, txt) => txt.includes("Timeout question"));
      const timeout = await expectReply(
        prompt.id,
        "question timeout message",
        (_, txt) => txt.includes("Question timed out"),
        20000
      );
      return { promptId: prompt.id, timeoutId: timeout.id };
    });

    await recordStep("no-response fallback", async () => {
      const sent = await sendText(`${tag} E2E:NO_RESPONSE`);
      const msg = await expectReply(sent.id, "no response fallback", (_, txt) => txt.includes("(no response)"));
      return { msgId: msg.id };
    });

    await recordStep("bad message fetch fallback", async () => {
      const sent = await sendText(`${tag} E2E:BAD_MESSAGES`);
      const msg = await expectReply(sent.id, "bad messages fallback", (_, txt) => txt.includes("could not retrieve the response"));
      return { msgId: msg.id };
    });

    await recordStep("long response chunking", async () => {
      const sent = await sendText(`${tag} E2E:LONG`);
      const first = await expectReply(sent.id, "long chunk 1", (_, txt) => txt.length === 4096, 30000);
      const second = await expectReply(first.id, "long chunk 2", (_, txt) => txt.length === 904, 30000);
      return { firstId: first.id, secondId: second.id };
    });

    await recordStep("abort idle response", async () => {
      const sent = await sendText("/abort");
      const msg = await expectReply(sent.id, "abort when idle", (_, txt) => txt.includes("Nothing is running right now"));
      return { msgId: msg.id };
    });

    await recordStep("abort busy flow", async () => {
      const running = await sendText(`${tag} E2E:ABORT_WAIT`);
      const abortCmd = await sendText("/abort");
      await expectReply(abortCmd.id, "abort ack", (_, txt) => txt.includes("Aborted."));
      const err = await expectReply(running.id, "abort session.error", (_, txt) => txt.includes("Aborted") && txt.includes("Aborted by E2E"));
      return { errId: err.id };
    });

    await recordStep("session.error flow", async () => {
      const sent = await sendText(`${tag} E2E:ERROR`);
      const msg = await expectReply(sent.id, "session error", (_, txt) => txt.includes("SessionError") && txt.includes("Synthetic E2E error"));
      return { msgId: msg.id };
    });

    await recordStep("SSE reconnect", async () => {
      const before = server.sseConnectionCount;
      server.closeSseClients();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (server.sseConnectionCount > before) break;
        await sleep(200);
      }
      if (server.sseConnectionCount <= before) {
        throw new Error("SSE reconnect did not occur");
      }

      const sent = await sendText(`${tag} E2E:ECHO after reconnect`);
      const msg = await expectReply(sent.id, "echo after reconnect", (_, txt) => txt.includes("Echo:") && txt.includes("after reconnect"));
      return { reconnectCount: server.sseConnectionCount, msgId: msg.id };
    });

    await recordStep("rehydration after bot restart", async () => {
      const beforeRestartCall = server.promptCalls[server.promptCalls.length - 1];
      if (!beforeRestartCall) throw new Error("No prompt call recorded before restart");
      const oldSessionId = beforeRestartCall.sessionId;

      await botProcess.stop();
      await clearPollingConflict(process.env.TELEGRAM_BOT_TOKEN);
      botProcess = new BotProcess(server.baseUrl);
      await botProcess.start();
      await sleep(1500);

      const sent = await sendText(`${tag} E2E:ECHO rehydrate check`);
      const msg = await expectReply(sent.id, "rehydrate reply", (_, txt) => txt.includes("rehydrate check"));

      const latestCall = server.promptCalls[server.promptCalls.length - 1];
      if (!latestCall) throw new Error("No prompt call recorded after restart");
      const rehydrated = latestCall.sessionId === oldSessionId;
      if (!rehydrated) {
        throw new Error(`Expected same session after restart, got ${oldSessionId} -> ${latestCall.sessionId}`);
      }
      return { oldSessionId, newSessionId: latestCall.sessionId, replyId: msg.id };
    });

    if ((botProcess.stderr || "").includes("409 Conflict")) {
      report.notes.push("Observed polling 409 conflict during run; another instance may be using this bot token.");
    }

    report.passed = report.steps.every((s) => s.ok);
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    report.passed = false;
    report.error = err.message;
    report.botStdout = botProcess ? botProcess.stdout : "";
    report.botStderr = botProcess ? botProcess.stderr : "";
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  } finally {
    try {
      if (botProcess) await botProcess.stop();
    } catch {}
    try {
      await client.disconnect();
    } catch {}
    try {
      await server.stop();
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
