"use strict";
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

// ─── Config ──────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENCODE_URL = (process.env.OPENCODE_SERVER_URL || "http://localhost:4096").replace(/\/$/, "");
const OC_USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const OC_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";

// How often to refresh the Telegram "typing…" indicator (ms). Must be < 5000.
const TYPING_INTERVAL_MS = 4000;
// How long to wait before treating a pending question/permission as stale (ms).
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
// SSE reconnect delay on error (ms)
const SSE_RECONNECT_DELAY_MS = 3000;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "your_telegram_bot_token_here") {
  console.error("[FATAL] Set TELEGRAM_BOT_TOKEN in your .env file");
  process.exit(1);
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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
 *   pendingQuestions: [{ requestId, questions[], messageIds[], timer }] | null,
 *   // For multi-question: track which question we are collecting
 *   questionState: { requestId, questions[], answers[], currentIdx, messageId } | null,
 * }
 */
const chatState = new Map();

function getState(chatId) {
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      sessionId: null,
      busy: false,
      pendingQueue: [],
      typingTimer: null,
      pendingPermission: null,
      questionState: null,
    });
  }
  return chatState.get(chatId);
}

// Reverse map: sessionId -> chatId (so SSE events can find the right chat)
const sessionToChat = new Map();

// ─── OpenCode HTTP helpers ────────────────────────────────────────────────────

function authHeader() {
  if (!OC_PASS) return {};
  const creds = Buffer.from(`${OC_USER}:${OC_PASS}`).toString("base64");
  return { Authorization: `Basic ${creds}` };
}

async function ocFetch(method, path, body) {
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenCode ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function createSession(chatId) {
  const session = await ocFetch("POST", "/session", {
    title: `Telegram Chat ${chatId}`,
  });
  return session.id;
}

async function sendPromptAsync(sessionId, text) {
  // Fire-and-forget — returns 204, AI response comes via SSE
  await ocFetch("POST", `/session/${sessionId}/prompt_async`, {
    parts: [{ type: "text", text }],
  });
}

async function replyPermission(requestId, reply) {
  return ocFetch("POST", `/permission/${requestId}/reply`, { reply });
}

async function replyQuestion(requestId, answers) {
  return ocFetch("POST", `/question/${requestId}/reply`, { answers });
}

async function rejectQuestion(requestId) {
  await ocFetch("POST", `/question/${requestId}/reject`, {});
}

// Fetch final assembled AI text for a session's last assistant message
async function fetchLastAssistantText(sessionId) {
  const messages = await ocFetch("GET", `/session/${sessionId}/message`);
  // messages is [{info, parts}], find last assistant
  const assistants = messages.filter((m) => m.info.role === "assistant");
  if (!assistants.length) return null;
  const last = assistants[assistants.length - 1];
  const text = last.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("")
    .trim();
  return text || null;
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function startTyping(chatId) {
  const state = getState(chatId);
  if (state.typingTimer) return; // already running
  const tick = () => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
    state.typingTimer = setTimeout(tick, TYPING_INTERVAL_MS);
  };
  bot.sendChatAction(chatId, "typing").catch(() => {});
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
  const MAX = 4096;
  if (!text || !text.trim()) return;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, opts).catch((err) => {
      console.error(`[sendLong] chatId=${chatId}:`, err.message);
    });
  }
}

// ─── Session management ───────────────────────────────────────────────────────

async function ensureSession(chatId) {
  const state = getState(chatId);
  if (state.sessionId) return state.sessionId;
  const id = await createSession(chatId);
  state.sessionId = id;
  sessionToChat.set(id, chatId);
  return id;
}

// ─── Handle incoming user message ────────────────────────────────────────────

async function handleUserMessage(chatId, text) {
  const state = getState(chatId);

  // If AI is busy, queue the message
  if (state.busy) {
    state.pendingQueue.push(text);
    await bot.sendMessage(chatId, "⏳ Still working on the previous request, I'll reply to this next.").catch(() => {});
    return;
  }

  // If user is in the middle of answering a question, treat this as the custom answer
  if (state.questionState) {
    await handleCustomQuestionAnswer(chatId, text);
    return;
  }

  state.busy = true;
  startTyping(chatId);

  try {
    const sessionId = await ensureSession(chatId);
    await sendPromptAsync(sessionId, text);
    // Response will come via SSE events — we stay "busy" until session.idle or session.error
  } catch (err) {
    state.busy = false;
    stopTyping(chatId);
    console.error(`[handleUserMessage] chatId=${chatId}:`, err.message);
    await sendLong(chatId, `Failed to send message to OpenCode:\n${err.message}\n\nIs OpenCode running? Try: opencode serve`);
  }
}

// ─── Process queued messages after AI finishes ───────────────────────────────

async function drainQueue(chatId) {
  const state = getState(chatId);
  if (!state.pendingQueue.length) return;
  const next = state.pendingQueue.shift();
  await handleUserMessage(chatId, next);
}

// ─── Permission handling ──────────────────────────────────────────────────────

async function handlePermissionAsked(chatId, req) {
  const state = getState(chatId);

  // Clear stale permission if any
  if (state.pendingPermission) {
    clearTimeout(state.pendingPermission.timer);
    state.pendingPermission = null;
  }

  stopTyping(chatId); // pause typing while user decides

  const { id: requestId, permission, metadata = {} } = req;

  // Build a readable description
  const lines = [`🔐 *Permission Request*`, ``, `OpenCode wants to: \`${permission}\``];
  if (metadata.command) lines.push(`Command: \`${metadata.command}\``);
  if (metadata.path) lines.push(`Path: \`${metadata.path}\``);
  if (metadata.description) lines.push(``, metadata.description);
  lines.push(``, `Allow this action?`);

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Allow Once", callback_data: `perm:once:${requestId}` },
        { text: "✅✅ Always Allow", callback_data: `perm:always:${requestId}` },
        { text: "❌ Deny", callback_data: `perm:reject:${requestId}` },
      ],
    ],
  };

  const sent = await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  }).catch((err) => {
    console.error(`[handlePermissionAsked] send failed:`, err.message);
    return null;
  });

  if (!sent) return;

  // Auto-timeout: if user doesn't respond in time, deny and unblock
  const timer = setTimeout(async () => {
    state.pendingPermission = null;
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: sent.message_id });
      await bot.sendMessage(chatId, "⚠️ Permission request timed out — denied automatically.");
      await replyPermission(requestId, "reject").catch(() => {});
    } catch {}
    // Don't set busy=false here — session.error/idle will handle that
  }, INTERACTION_TIMEOUT_MS);

  state.pendingPermission = { requestId, messageId: sent.message_id, timer };
  startTyping(chatId); // keep showing activity
}

// ─── Question handling ────────────────────────────────────────────────────────

async function handleQuestionAsked(chatId, req) {
  const state = getState(chatId);

  // Clear any stale question state
  if (state.questionState) {
    clearTimeout(state.questionState.timer);
    state.questionState = null;
  }

  stopTyping(chatId);

  const { id: requestId, questions } = req;

  if (!questions || !questions.length) {
    // Edge case: empty questions — just reject
    await rejectQuestion(requestId).catch(() => {});
    startTyping(chatId);
    return;
  }

  // We collect answers one question at a time
  state.questionState = {
    requestId,
    questions,
    answers: [],
    currentIdx: 0,
    timer: setTimeout(async () => {
      // Timeout: reject the whole question
      const qs = state.questionState;
      if (!qs) return;
      state.questionState = null;
      await rejectQuestion(requestId).catch(() => {});
      await bot.sendMessage(chatId, "⚠️ Question timed out — skipped.").catch(() => {});
    }, INTERACTION_TIMEOUT_MS),
  };

  await askCurrentQuestion(chatId);
}

async function askCurrentQuestion(chatId) {
  const state = getState(chatId);
  const qs = state.questionState;
  if (!qs) return;

  const q = qs.questions[qs.currentIdx];
  const total = qs.questions.length;
  const idx = qs.currentIdx;

  const prefix = total > 1 ? `*Question ${idx + 1} of ${total}*\n\n` : "";
  const text = `${prefix}${q.question}`;

  // If there are options, show as inline buttons
  if (q.options && q.options.length) {
    // Use option INDEX in callback_data to stay well within Telegram's 64-byte limit.
    // Format: qans:<requestId>:<questionIdx>:<optionIdx>
    const rows = q.options.map((opt, optIdx) => [
      {
        text: opt.label,
        callback_data: `qans:${qs.requestId}:${idx}:${optIdx}`,
      },
    ]);

    // If custom input allowed (default true), add a "Type custom answer" hint
    const customAllowed = q.custom !== false;
    const footer = customAllowed ? `\n\n_Or type your own answer_` : "";

    await bot.sendMessage(chatId, text + footer, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    }).catch((err) => console.error(`[askCurrentQuestion] send failed:`, err.message));
  } else {
    // Free-text only
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
  }
}

async function handleCustomQuestionAnswer(chatId, text) {
  const state = getState(chatId);
  const qs = state.questionState;
  if (!qs) return;

  const q = qs.questions[qs.currentIdx];
  const customAllowed = q.custom !== false;
  if (!customAllowed) {
    await bot.sendMessage(chatId, "Please choose one of the options above.").catch(() => {});
    return;
  }

  await advanceQuestionAnswer(chatId, text);
}

async function advanceQuestionAnswer(chatId, selectedLabel) {
  const state = getState(chatId);
  const qs = state.questionState;
  if (!qs) return;

  // Record answer as array-of-labels (OpenCode expects array of arrays)
  qs.answers.push([selectedLabel]);
  qs.currentIdx++;

  if (qs.currentIdx < qs.questions.length) {
    // More questions to go
    await askCurrentQuestion(chatId);
  } else {
    // All answered — submit
    clearTimeout(qs.timer);
    state.questionState = null;

    try {
      await replyQuestion(qs.requestId, qs.answers);
      await bot.sendMessage(chatId, "✅ Answers submitted, continuing...").catch(() => {});
      startTyping(chatId);
    } catch (err) {
      console.error(`[advanceQuestionAnswer] reply failed:`, err.message);
      await bot.sendMessage(chatId, `Failed to submit answers: ${err.message}`).catch(() => {});
    }
  }
}

// ─── Session idle: AI finished ────────────────────────────────────────────────

async function handleSessionIdle(chatId, sessionId) {
  const state = getState(chatId);
  stopTyping(chatId);
  state.busy = false;

  // Clear any leftover interaction state (shouldn't happen but defensive)
  if (state.pendingPermission) {
    clearTimeout(state.pendingPermission.timer);
    state.pendingPermission = null;
  }
  if (state.questionState) {
    clearTimeout(state.questionState.timer);
    state.questionState = null;
  }

  // Fetch final response text
  try {
    const text = await fetchLastAssistantText(sessionId);
    if (text) {
      await sendLong(chatId, text);
    } else {
      await bot.sendMessage(chatId, "_(no response)_").catch(() => {});
    }
  } catch (err) {
    console.error(`[handleSessionIdle] fetch failed:`, err.message);
    await bot.sendMessage(chatId, `OpenCode finished but could not retrieve the response: ${err.message}`).catch(() => {});
  }

  // Process any queued messages
  await drainQueue(chatId);
}

// ─── Session error ────────────────────────────────────────────────────────────

async function handleSessionError(chatId, error) {
  const state = getState(chatId);
  stopTyping(chatId);
  state.busy = false;

  if (state.pendingPermission) {
    clearTimeout(state.pendingPermission.timer);
    state.pendingPermission = null;
  }
  if (state.questionState) {
    clearTimeout(state.questionState.timer);
    state.questionState = null;
  }

  const name = error?.name || "Error";
  const message = error?.data?.message || error?.message || JSON.stringify(error);
  await bot.sendMessage(chatId, `❌ *${name}*: ${message}`, { parse_mode: "Markdown" }).catch(() => {});

  await drainQueue(chatId);
}

// ─── SSE event dispatcher ─────────────────────────────────────────────────────

function dispatchEvent(event) {
  const type = event?.payload?.type;
  const props = event?.payload?.properties || {};

  switch (type) {
    case "permission.asked": {
      const chatId = sessionToChat.get(props.sessionID);
      if (!chatId) return;
      handlePermissionAsked(chatId, props).catch((err) =>
        console.error("[dispatch permission.asked]", err.message)
      );
      break;
    }

    case "question.asked": {
      const chatId = sessionToChat.get(props.sessionID);
      if (!chatId) return;
      handleQuestionAsked(chatId, props).catch((err) =>
        console.error("[dispatch question.asked]", err.message)
      );
      break;
    }

    case "session.idle": {
      const chatId = sessionToChat.get(props.sessionID);
      if (!chatId) return;
      handleSessionIdle(chatId, props.sessionID).catch((err) =>
        console.error("[dispatch session.idle]", err.message)
      );
      break;
    }

    case "session.error": {
      const chatId = sessionToChat.get(props.sessionID);
      if (!chatId) return;
      handleSessionError(chatId, props.error).catch((err) =>
        console.error("[dispatch session.error]", err.message)
      );
      break;
    }

    // Ignore all other events
    default:
      break;
  }
}

// ─── SSE connection with auto-reconnect ──────────────────────────────────────

let sseAbortController = null;

async function connectSSE() {
  if (sseAbortController) sseAbortController.abort();
  sseAbortController = new AbortController();

  console.log("[SSE] Connecting to OpenCode event stream...");

  try {
    const res = await fetch(`${OPENCODE_URL}/global/event`, {
      headers: { Accept: "text/event-stream", ...authHeader() },
      signal: sseAbortController.signal,
    });

    if (!res.ok) {
      throw new Error(`SSE connect failed: ${res.status} ${await res.text()}`);
    }

    console.log("[SSE] Connected.");

    let buffer = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          const event = JSON.parse(raw);
          dispatchEvent(event);
        } catch (e) {
          console.error("[SSE] JSON parse error:", e.message, "raw:", raw.slice(0, 100));
        }
      }
    }

    console.log("[SSE] Stream ended. Reconnecting...");
  } catch (err) {
    if (err.name === "AbortError") return; // intentional disconnect
    console.error(`[SSE] Error: ${err.message}. Reconnecting in ${SSE_RECONNECT_DELAY_MS}ms...`);
  }

  setTimeout(connectSSE, SSE_RECONNECT_DELAY_MS);
}

// ─── Telegram callback queries (button taps) ─────────────────────────────────

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";
  const messageId = query.message?.message_id;

  // Always answer the callback to remove the loading spinner
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (!chatId) return;
  const state = getState(chatId);

  // ── Permission response ──
  if (data.startsWith("perm:")) {
    const parts = data.split(":");
    const reply = parts[1]; // once | always | reject
    const requestId = parts[2];

    // Clear any matching in-memory pending state (best-effort — may be null after restart)
    if (state.pendingPermission && state.pendingPermission.requestId === requestId) {
      clearTimeout(state.pendingPermission.timer);
      state.pendingPermission = null;
    }

    // Remove buttons from the message regardless of in-memory state
    const replyText =
      reply === "once" ? "✅ Allowed (once)" :
      reply === "always" ? "✅ Allowed (always)" :
      "❌ Denied";

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {});
    await bot.sendMessage(chatId, replyText).catch(() => {});

    // Submit to OpenCode — it will reject if the request is no longer valid
    try {
      await replyPermission(requestId, reply);
      startTyping(chatId);
    } catch (err) {
      console.error(`[callback perm] reply failed:`, err.message);
      await bot.sendMessage(chatId, `Failed to send permission response: ${err.message}`).catch(() => {});
    }
    return;
  }

  // ── Question option selected ──
  if (data.startsWith("qans:")) {
    // format: qans:<requestId>:<questionIdx>:<optionIdx>
    const parts = data.split(":");
    const requestId = parts[1];
    const questionIdx = parseInt(parts[2], 10);
    const optionIdx = parseInt(parts[3], 10);

    // If in-memory state matches, use it to get the label from stored questions
    if (state.questionState && state.questionState.requestId === requestId) {
      if (state.questionState.currentIdx !== questionIdx) {
        // Old button for a previous question in a multi-question flow — ignore
        return;
      }

      const q = state.questionState.questions[questionIdx];
      const option = q.options && q.options[optionIdx];
      if (!option) {
        await bot.sendMessage(chatId, "⚠️ Invalid option selected.").catch(() => {});
        return;
      }
      const label = option.label;

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});
      await bot.sendMessage(chatId, `Selected: *${label}*`, { parse_mode: "Markdown" }).catch(() => {});

      await advanceQuestionAnswer(chatId, label);
      return;
    }

    // In-memory state is gone (e.g. bot restarted) but question may still be pending in OpenCode.
    // The question.asked SSE event replays on reconnect so questionState should be restored shortly.
    // Tell the user to wait and re-tap.
    await bot.sendMessage(chatId, "⏳ Still reconnecting — please wait a moment and try tapping again.").catch(() => {});
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
  const state = getState(chatId);

  // Clear all state for this chat
  stopTyping(chatId);
  if (state.pendingPermission) {
    clearTimeout(state.pendingPermission.timer);
    state.pendingPermission = null;
  }
  if (state.questionState) {
    clearTimeout(state.questionState.timer);
    state.questionState = null;
  }
  if (state.sessionId) sessionToChat.delete(state.sessionId);
  state.sessionId = null;
  state.busy = false;
  state.pendingQueue = [];

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
    await ocFetch("POST", `/session/${state.sessionId}/abort`, {});
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

// ─── Startup: re-register existing Telegram sessions ─────────────────────────

/**
 * On startup, fetch all sessions from OpenCode and re-register any session
 * whose title is "Telegram Chat <chatId>" back into sessionToChat and chatState.
 * This ensures that if the bot restarts while OpenCode has pending events
 * (questions, permissions, idle) for sessions we created, we can still route them.
 */
async function rehydrateSessions() {
  try {
    const sessions = await ocFetch("GET", "/session");
    if (!Array.isArray(sessions)) return;
    for (const s of sessions) {
      const match = s.title && s.title.match(/^Telegram Chat (-?\d+)$/);
      if (!match) continue;
      const chatId = parseInt(match[1], 10);
      sessionToChat.set(s.id, chatId);
      const state = getState(chatId);
      if (!state.sessionId) {
        state.sessionId = s.id;
      } else {
        const currentSessions = sessions.filter((x) => {
          const m = x.title && x.title.match(/^Telegram Chat (-?\d+)$/);
          return m && parseInt(m[1], 10) === chatId;
        });
        const newest = currentSessions.reduce((a, b) =>
          (a.time?.updated || 0) > (b.time?.updated || 0) ? a : b
        );
        state.sessionId = newest.id;
        for (const cs of currentSessions) {
          sessionToChat.set(cs.id, chatId);
        }
      }
    }
  } catch (err) {
    console.error(`[rehydrateSessions] ${err.message}`);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

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
  if (sseAbortController) sseAbortController.abort();
  bot.stopPolling();
  process.exit(0);
});

console.log(`[BOT] Starting OpenCode Telegram Bot`);
console.log(`[BOT] OpenCode server: ${OPENCODE_URL}`);

// Re-register existing sessions, then start SSE listener
rehydrateSessions().then(() => connectSSE());
