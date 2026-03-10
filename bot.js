"use strict";
const { config, validate } = require("./src/config");
const SessionManager = require("./src/state/SessionManager");
const OpenCodeClient = require("./src/opencode/OpenCodeClient");
const SSEConnection = require("./src/opencode/SSEConnection");
const { splitMessage } = require("./src/bot/messageFormatter");
const TelegramBotWrapper = require("./src/bot/TelegramBot");
const PermissionHandler = require("./src/handlers/PermissionHandler");
const QuestionHandler = require("./src/handlers/QuestionHandler");
const MessageHandler = require("./src/handlers/MessageHandler");
const SHOULD_START = require.main === module || process.env.BOOT_BOT === "1";

// ─── Config ──────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = config.telegramToken;
const OPENCODE_URL = config.openCodeUrl;
const OC_USER = config.ocUser;
const OC_PASS = config.ocPass;

// How often to refresh the Telegram "typing…" indicator (ms). Must be < 5000.
const TYPING_INTERVAL_MS = config.typingIntervalMs;
// How long to wait before treating a pending question/permission as stale (ms).
const INTERACTION_TIMEOUT_MS = config.interactionTimeoutMs;
// SSE reconnect delay on error (ms)
const SSE_RECONNECT_DELAY_MS = config.sseReconnectDelayMs;
validate();

// ─── Bot ─────────────────────────────────────────────────────────────────────

let bot;
let tgWrapper;
if (SHOULD_START) {
  tgWrapper = new TelegramBotWrapper({ token: TELEGRAM_TOKEN });
  bot = tgWrapper.bot;
} else {
  // Test mode: inject a mock via setBotInstance()
  tgWrapper = null;
  bot = null;
}

function setBotInstance(mockBot) {
  tgWrapper = new TelegramBotWrapper({ bot: mockBot });
  bot = mockBot;
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Per-chat state:
 * {
 *   sessionId: string | null,
 *   busy: boolean,               // AI is currently processing
 *   pendingQueue: string[],      // messages received while busy
 *   typingTimer: NodeJS.Timeout | null,
 *   // Active interactions waiting for user response on Telegram
 *   pendingPermission: { requestId, messageId, timer } | null,
 *   // For multi-question: track which question we are collecting
 *   questionState: { requestId, questions[], answers[], currentIdx, messageId } | null,
 * }
 */
const sessionManager = new SessionManager({ maxQueueLength: config.maxQueueLength });
const chatState = sessionManager.chatState;
const sessionToChat = sessionManager.sessionToChat;
const openCodeClient = new OpenCodeClient({
  baseUrl: OPENCODE_URL,
  username: OC_USER,
  password: OC_PASS,
});

function getState(chatId) {
  return sessionManager.getState(chatId);
}

// ─── OpenCode HTTP helpers ────────────────────────────────────────────────────

function authHeader() {
  return openCodeClient.authHeader();
}

async function ocFetch(method, path, body) {
  return openCodeClient.fetch(method, path, body);
}

async function createSession(chatId) {
  return openCodeClient.createSession(chatId);
}

async function sendPromptAsync(sessionId, text) {
  await openCodeClient.sendPromptAsync(sessionId, text);
}

async function replyPermission(requestId, reply) {
  return openCodeClient.replyPermission(requestId, reply);
}

async function replyQuestion(requestId, answers) {
  return openCodeClient.replyQuestion(requestId, answers);
}

async function rejectQuestion(requestId) {
  await openCodeClient.rejectQuestion(requestId);
}

// Fetch final assembled AI text for a session's last assistant message
async function fetchLastAssistantText(sessionId) {
  return openCodeClient.fetchLastAssistantText(sessionId);
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function startTyping(chatId) {
  const state = getState(chatId);
  if (state.typingTimer) return; // already running
  const tick = () => {
    if (tgWrapper) {
      tgWrapper.safeSendTyping(chatId);
    } else {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }
    state.typingTimer = setTimeout(tick, TYPING_INTERVAL_MS);
  };
  if (tgWrapper) {
    tgWrapper.safeSendTyping(chatId);
  } else {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }
  state.typingTimer = setTimeout(tick, TYPING_INTERVAL_MS);
}

function stopTyping(chatId) {
  const state = getState(chatId);
  if (state.typingTimer) {
    clearTimeout(state.typingTimer);
    state.typingTimer = null;
  }
}

// ─── Send long message (split at 4096) ───────────────────────────────────────

async function sendLong(chatId, text, opts = {}) {
  if (!text || !text.trim()) return;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    if (tgWrapper) {
      await tgWrapper.safeSend(chatId, chunk, opts);
      continue;
    }
    await bot.sendMessage(chatId, chunk, opts).catch((err) => {
      console.error(`[sendLong] chatId=${chatId}:`, err.message);
    });
  }
}

// ─── Session management ───────────────────────────────────────────────────────

async function ensureSession(chatId) {
  return sessionManager.ensureSession(chatId, createSession);
}

const permissionHandler = new PermissionHandler({
  getBot: () => bot,
  getState,
  replyPermission,
  startTyping,
  stopTyping,
  interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
});

const questionHandler = new QuestionHandler({
  getBot: () => bot,
  getState,
  replyQuestion,
  rejectQuestion,
  startTyping,
  stopTyping,
  interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
});

const messageHandler = new MessageHandler({
  getBot: () => bot,
  getState,
  sessionManager,
  ensureSession,
  sendPromptAsync,
  startTyping,
  stopTyping,
  sendLong,
  fetchLastAssistantText,
  questionHandler,
});

// ─── Handler wrappers (kept for test compatibility) ──────────────────────────

async function handleUserMessage(chatId, text) {
  return messageHandler.handleUserMessage(chatId, text);
}

async function drainQueue(chatId) {
  return messageHandler.drainQueue(chatId);
}

async function handlePermissionAsked(chatId, req) {
  return permissionHandler.handleAsked(chatId, req);
}

async function handleQuestionAsked(chatId, req) {
  return questionHandler.handleAsked(chatId, req);
}

async function askCurrentQuestion(chatId) {
  return questionHandler.askCurrent(chatId);
}

async function handleCustomQuestionAnswer(chatId, text) {
  return questionHandler.handleCustomAnswer(chatId, text);
}

async function advanceQuestionAnswer(chatId, selectedLabel) {
  return questionHandler.advanceAnswer(chatId, selectedLabel);
}

async function handleSessionIdle(chatId, sessionId) {
  return messageHandler.handleSessionIdle(chatId, sessionId);
}

async function handleSessionError(chatId, error) {
  return messageHandler.handleSessionError(chatId, error);
}

// ─── SSE event dispatcher ─────────────────────────────────────────────────────

const sseConnection = new SSEConnection({
  baseUrl: OPENCODE_URL,
  authHeader,
  reconnectDelayMs: SSE_RECONNECT_DELAY_MS,
});

sseConnection.on("permission.asked", (props) => {
  const chatId = sessionToChat.get(props.sessionID);
  if (!chatId) return;
  return handlePermissionAsked(chatId, props);
});
sseConnection.on("question.asked", (props) => {
  const chatId = sessionToChat.get(props.sessionID);
  if (!chatId) return;
  return handleQuestionAsked(chatId, props);
});
sseConnection.on("session.idle", (props) => {
  const chatId = sessionToChat.get(props.sessionID);
  if (!chatId) return;
  return handleSessionIdle(chatId, props.sessionID);
});
sseConnection.on("session.error", (props) => {
  const chatId = sessionToChat.get(props.sessionID);
  if (!chatId) return;
  return handleSessionError(chatId, props.error);
});

function dispatchEvent(event) {
  sseConnection.dispatch(event);
}

async function connectSSE() {
  return sseConnection.connect();
}

// ─── Telegram callback queries (button taps) ─────────────────────────────────

if (SHOULD_START) {
  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    const data = query.data || "";
    const messageId = query.message?.message_id;

    // Always answer the callback to remove the loading spinner
    bot.answerCallbackQuery(query.id).catch(() => {});

    if (!chatId) return;
    const state = getState(chatId);

    if (await permissionHandler.handleCallback(chatId, data, messageId, state)) {
      return;
    }

    if (await questionHandler.handleCallback(chatId, data, messageId, state)) {
      return;
    }
  });

  // ─── Telegram message handlers ────────────────────────────────────────────────

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const state = getState(chatId);
    if (state.sessionId) {
      await bot.sendMessage(chatId, "Already connected! Send me a message to chat with OpenCode.");
      return;
    }
    try {
      await ensureSession(chatId);
      await bot.sendMessage(chatId, "Connected to OpenCode! Ask me anything about your code.");
    } catch (err) {
      await bot.sendMessage(chatId, `Could not connect to OpenCode at ${OPENCODE_URL}.\nError: ${err.message}`);
    }
  });

  bot.onText(/\/new/, async (msg) => {
    const chatId = msg.chat.id;

    // Clear all state for this chat
    stopTyping(chatId);
    sessionManager.resetChat(chatId);

    try {
      await ensureSession(chatId);
      await bot.sendMessage(chatId, "Started a fresh session!");
    } catch (err) {
      await bot.sendMessage(chatId, `Failed to create session: ${err.message}`);
    }
  });

  bot.onText(/\/abort/, async (msg) => {
    const chatId = msg.chat.id;
    const state = getState(chatId);
    if (!state.sessionId || !state.busy) {
      await bot.sendMessage(chatId, "Nothing is running right now.");
      return;
    }
    try {
      await openCodeClient.abortSession(state.sessionId);
      await bot.sendMessage(chatId, "⛔ Aborted.");
      // session.idle or session.error will fire from SSE and clean up state
    } catch (err) {
      await bot.sendMessage(chatId, `Failed to abort: ${err.message}`);
    }
  });

  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `*OpenCode Telegram Bot*\n\nSend any message to chat with the AI.\n\n*Commands:*\n/start — Connect to OpenCode\n/new — Start a fresh session\n/abort — Abort current AI task\n/help — Show this message\n\n*During a task:*\n• Permission requests will appear as buttons (Allow / Deny)\n• Questions will appear as buttons or free-text prompts\n• Multiple messages while busy are queued and processed in order`,
      { parse_mode: "Markdown" }
    );
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands
    if (!text || text.startsWith("/")) return;

    await handleUserMessage(chatId, text);
  });
} // end if (SHOULD_START) for Telegram handlers

// ─── Startup: re-register existing Telegram sessions ─────────────────────────

/**
 * On startup, fetch all sessions from OpenCode and re-register any session
 * whose title is "Telegram Chat <chatId>" back into sessionToChat and chatState.
 * This ensures that if the bot restarts while OpenCode has pending events
 * (questions, permissions, idle) for sessions we created, we can still route them.
 */
async function rehydrateSessions() {
  return sessionManager.rehydrateSessions(() => ocFetch("GET", "/session"));
}

// ─── Startup ──────────────────────────────────────────────────────────────────

if (SHOULD_START) {
  // Handle uncaught errors gracefully — don't crash the bot
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err.message, err.stack);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[SHUTDOWN] Stopping bot...");
    sseConnection.disconnect();
    if (tgWrapper) tgWrapper.stop();
    process.exit(0);
  });

  console.log(`[BOT] Starting OpenCode Telegram Bot`);
  console.log(`[BOT] OpenCode server: ${OPENCODE_URL}`);

  // Re-register existing sessions, then start SSE listener
  rehydrateSessions().then(() => connectSSE());
}

// ─── Exports for testing (no-op in production) ────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    setBotInstance,
    // State
    getState,
    chatState,
    sessionToChat,
    // OpenCode HTTP
    authHeader,
    ocFetch,
    createSession,
    sendPromptAsync,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    fetchLastAssistantText,
    // Typing
    startTyping,
    stopTyping,
    // Messaging
    sendLong,
    // Session
    ensureSession,
    // Handlers
    handleUserMessage,
    drainQueue,
    handlePermissionAsked,
    handleQuestionAsked,
    askCurrentQuestion,
    handleCustomQuestionAnswer,
    advanceQuestionAnswer,
    handleSessionIdle,
    handleSessionError,
    // SSE
    dispatchEvent,
    // Startup
    rehydrateSessions,
    // Constants (for test assertions)
    TYPING_INTERVAL_MS,
    INTERACTION_TIMEOUT_MS,
    SSE_RECONNECT_DELAY_MS,
  };
}
