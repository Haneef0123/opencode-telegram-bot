# Test-First Refactoring Plan — OpenCode Telegram Bot

## Goal

Safely refactor a monolithic 784-line `bot.js` into modular, DRY, SOLID-compliant code **without breaking anything**. Strategy: build a comprehensive test suite first, then refactor phase by phase with tests as the safety net.

---

# PART A — Test Suite (Before Any Refactoring)

## A.0 — Test Infrastructure Setup

### Dependencies to Install

```bash
npm install --save-dev jest
```

### Files to Create

```
opencode-telegram-bot/
├── jest.config.js                        # [NEW]
├── __mocks__/
│   └── node-telegram-bot-api.js          # [NEW] Mock for TelegramBot
├── tests/
│   ├── helpers/
│   │   └── setup.js                      # [NEW] Shared test setup, mock factories
│   ├── config.test.js                    # [NEW] Config loading & validation
│   ├── state.test.js                     # [NEW] getState, chatState, sessionToChat
│   ├── opencode-client.test.js           # [NEW] ocFetch, createSession, etc.
│   ├── typing.test.js                    # [NEW] startTyping, stopTyping
│   ├── sendLong.test.js                  # [NEW] Message splitting
│   ├── session.test.js                   # [NEW] ensureSession, rehydrateSessions
│   ├── handlers.test.js                  # [NEW] handleUserMessage, drainQueue, idle, error
│   ├── permission.test.js               # [NEW] Permission ask/reply/timeout flow
│   ├── question.test.js                 # [NEW] Question ask/reply/advance/timeout flow
│   ├── sse.test.js                       # [NEW] dispatchEvent, connectSSE
│   ├── commands.test.js                  # [NEW] /start, /new, /abort, /help
│   └── callbacks.test.js                # [NEW] callback_query handler for perm: and qans:
```

### Modification to `package.json`

Add to `"scripts"`:
```json
"test": "jest --verbose --forceExit",
"test:watch": "jest --watch --verbose --forceExit"
```

### Why `bot.js` Needs Minor Modification for Testability

The current `bot.js` has **all functions as module-scoped closures** — they cannot be imported/tested individually. Before writing tests, we must **export the internal functions** from `bot.js` without changing any logic. This is the ONLY change to `bot.js` in Part A.

Add at the **very bottom** of `bot.js` (after line 783, before the empty final line):

```js
// ─── Exports for testing (no-op in production) ──────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
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
    TYPING_INTERVAL_MS: 4000,
    INTERACTION_TIMEOUT_MS: 10 * 60 * 1000,
    SSE_RECONNECT_DELAY_MS: 3000,
  };
}
```

**BUT** there is a problem: `bot.js` **executes side effects on require** — it reads env vars, creates a `TelegramBot` instance, sets up handlers, calls `rehydrateSessions()`, and starts SSE. Tests cannot `require("./bot")` without these firing.

**Solution:** We must refactor the top-level side effects to be guarded by a `if (require.main === module)` check. Move lines 779-783 (startup code) inside this guard:

```js
// ─── Startup (only when run directly, not when required by tests) ───────────
if (require.main === module) {
  console.log(`[BOT] Starting OpenCode Telegram Bot`);
  console.log(`[BOT] OpenCode server: ${OPENCODE_URL}`);
  rehydrateSessions().then(() => connectSSE());
}
```

Also, the `TelegramBot` instantiation (line 26) and the event handler registrations (lines 557, 646, 661, 688, 704, 712) fire on require. We wrap them:

```js
let bot;
if (require.main === module) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  // ... all bot.on() and bot.onText() registrations
} else {
  // Test mode: use a mock bot injected via module.exports.setBotInstance()
  bot = null;
}
```

And add a setter for tests:
```js
function setBotInstance(mockBot) {
  bot = mockBot;
}
```

> [!IMPORTANT]
> These changes are purely structural (guard side effects, export functions). **Zero logic changes.** The bot behaves identically when run via `npm start` (`require.main === module` is true).

---

## A.1 — Mock Strategy

### Global Mock: `__mocks__/node-telegram-bot-api.js`

```js
class MockTelegramBot {
  constructor() {
    this.sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
    this.sendChatAction = jest.fn().mockResolvedValue(true);
    this.editMessageReplyMarkup = jest.fn().mockResolvedValue(true);
    this.answerCallbackQuery = jest.fn().mockResolvedValue(true);
    this.stopPolling = jest.fn();
    this._handlers = {};
  }
  on(event, handler) { this._handlers[event] = handler; }
  onText(regex, handler) { /* store for test triggering */ }
}
module.exports = MockTelegramBot;
```

### Global Mock: `fetch`

In `tests/helpers/setup.js`:

```js
function createMockFetch(responses = {}) {
  return jest.fn().mockImplementation(async (url, opts) => {
    const path = new URL(url).pathname;
    const response = responses[path] || { ok: true, status: 200, body: "{}" };
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      body: response.stream || null, // for SSE tests
    };
  });
}
```

### Shared Test Setup

```js
// tests/helpers/setup.js
function resetBotState(bot) {
  // Clear all Maps
  bot.chatState.clear();
  bot.sessionToChat.clear();
  // Clear all timers
  jest.clearAllTimers();
}

function createMockBot() {
  return {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    sendChatAction: jest.fn().mockResolvedValue(true),
    editMessageReplyMarkup: jest.fn().mockResolvedValue(true),
    answerCallbackQuery: jest.fn().mockResolvedValue(true),
    stopPolling: jest.fn(),
  };
}
```

---

## A.2 — Test Specifications (All Test Cases)

### File: `tests/config.test.js` — 5 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `OPENCODE_URL` strips trailing slash | `"http://localhost:4096/"` → `"http://localhost:4096"` |
| 2 | `OPENCODE_URL` defaults to `http://localhost:4096` | When env var is not set |
| 3 | `OC_USER` defaults to `"opencode"` | When env var is not set |
| 4 | `OC_PASS` defaults to `""` | When env var is not set |
| 5 | `authHeader()` returns empty object when no password | `OC_PASS = ""` → `{}` |
| 6 | `authHeader()` returns Basic auth when password is set | `OC_PASS = "secret"` → `{ Authorization: "Basic ..." }` |

**Implementation notes:**
- These tests will directly test the `authHeader()` function
- Config values are module-scoped constants, so we test them via the exported functions that use them
- The `process.exit(1)` on missing token cannot be easily tested in-process; document it as a manual verification

---

### File: `tests/state.test.js` — 8 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `getState(chatId)` creates default state for new chatId | Returns `{ sessionId: null, busy: false, pendingQueue: [], typingTimer: null, pendingPermission: null, questionState: null }` |
| 2 | `getState(chatId)` returns same object on repeated calls | Referential equality |
| 3 | `getState` with different chatIds returns different objects | Isolation between chats |
| 4 | Mutating returned state persists | `getState(1).busy = true; expect(getState(1).busy).toBe(true)` |
| 5 | `chatState.clear()` resets all state | After clear, `getState(1)` returns fresh defaults |
| 6 | `sessionToChat` maps sessionId → chatId | Basic Map operations |
| 7 | Multiple sessions can map to same chatId | For rehydration scenario |
| 8 | `sessionToChat.delete()` removes mapping | Cleanup on `/new` |

---

### File: `tests/opencode-client.test.js` — 14 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `ocFetch("GET", "/session")` sends correct URL | `OPENCODE_URL + /session` |
| 2 | `ocFetch` includes Content-Type header | `application/json` |
| 3 | `ocFetch` includes auth header when password set | Basic auth present |
| 4 | `ocFetch` sends JSON body for POST | `JSON.stringify(body)` |
| 5 | `ocFetch` sends no body for GET | `body: undefined` |
| 6 | `ocFetch` returns parsed JSON on success | 200 + JSON body |
| 7 | `ocFetch` returns raw text when JSON parse fails | 200 + non-JSON body |
| 8 | `ocFetch` throws on non-OK status | 500 → `Error("OpenCode 500: ...")` |
| 9 | `createSession(chatId)` sends correct payload | `{ title: "Telegram Chat 12345" }` |
| 10 | `createSession` returns session.id | Extracts `.id` from response |
| 11 | `sendPromptAsync` sends correct payload | `{ parts: [{ type: "text", text: "hello" }] }` |
| 12 | `replyPermission` sends to correct path | `/permission/{id}/reply` |
| 13 | `replyQuestion` sends answers in correct format | `{ answers: [[...]] }` |
| 14 | `fetchLastAssistantText` filters and joins correctly | Filters by `role: "assistant"`, excludes `synthetic` and `ignored` parts, joins text |

**Detailed test for `fetchLastAssistantText`:**

```js
test("fetchLastAssistantText returns joined text of last assistant message", async () => {
  global.fetch = createMockFetch({
    "/session/sess1/message": {
      body: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [
          { type: "text", text: "Part 1. ", synthetic: false, ignored: false },
          { type: "text", text: "Part 2.", synthetic: false, ignored: false },
          { type: "text", text: "IGNORED", synthetic: true, ignored: false },
          { type: "text", text: "ALSO IGNORED", synthetic: false, ignored: true },
        ]},
        { info: { role: "assistant" }, parts: [
          { type: "text", text: "Latest reply." },
        ]},
      ]
    }
  });
  const result = await bot.fetchLastAssistantText("sess1");
  expect(result).toBe("Latest reply.");
});
```

Additional edge case tests:
- Returns `null` when no assistant messages exist
- Returns `null` when text is empty/whitespace-only after filtering
- Handles messages array being empty

---

### File: `tests/typing.test.js` — 6 tests

Uses `jest.useFakeTimers()`.

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `startTyping` calls `sendChatAction("typing")` immediately | First call is synchronous |
| 2 | `startTyping` is idempotent | Calling twice doesn't create two timers |
| 3 | `startTyping` refreshes every `TYPING_INTERVAL_MS` | After `jest.advanceTimersByTime(4000)`, second call |
| 4 | `stopTyping` clears the timer | `state.typingTimer` becomes `null` |
| 5 | `stopTyping` is safe to call when not typing | No error thrown |
| 6 | `sendChatAction` errors are silently caught | `.catch(() => {})` doesn't throw |

---

### File: `tests/sendLong.test.js` — 7 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | Short message (< 4096) sent as single message | `sendMessage` called once |
| 2 | Exactly 4096 chars sent as single message | Boundary check |
| 3 | 4097 chars split into 2 messages | `sendMessage` called twice |
| 4 | 8192 chars split into 2 messages of 4096 each | Even split |
| 5 | Empty/whitespace-only string is not sent | `sendMessage` not called |
| 6 | `null` text is not sent | No crash |
| 7 | Options are passed through to each chunk | `{ parse_mode: "Markdown" }` forwarded |

**Implementation:**

```js
test("splits message at 4096 characters", async () => {
  const text = "A".repeat(5000);
  await bot.sendLong(123, text);
  expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
  expect(mockBot.sendMessage.mock.calls[0][1]).toHaveLength(4096);
  expect(mockBot.sendMessage.mock.calls[1][1]).toHaveLength(904);
});
```

---

### File: `tests/session.test.js` — 10 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `ensureSession` creates session if none exists | Calls `createSession`, sets `state.sessionId`, registers in `sessionToChat` |
| 2 | `ensureSession` returns existing session if already set | Does not call `createSession` |
| 3 | `ensureSession` returns the sessionId | Return value check |
| 4 | `rehydrateSessions` registers sessions with matching titles | `"Telegram Chat 123"` → chatId 123 |
| 5 | `rehydrateSessions` ignores non-matching titles | `"My Session"` → skipped |
| 6 | `rehydrateSessions` handles negative chatIds | `"Telegram Chat -456"` → chatId -456 (Telegram groups have negative IDs) |
| 7 | `rehydrateSessions` picks newest session for duplicate chatIds | Based on `time.updated` |
| 8 | `rehydrateSessions` handles empty session list | No crash |
| 9 | `rehydrateSessions` handles API error | Logs error, doesn't throw |
| 10 | `rehydrateSessions` handles non-array response | Defensive check |

**Detailed test for rehydration with duplicates:**

```js
test("rehydrateSessions picks the newest session per chatId", async () => {
  global.fetch = createMockFetch({
    "/session": {
      body: [
        { id: "old-sess", title: "Telegram Chat 100", time: { updated: 1000 } },
        { id: "new-sess", title: "Telegram Chat 100", time: { updated: 2000 } },
      ]
    }
  });
  await bot.rehydrateSessions();
  expect(bot.getState(100).sessionId).toBe("new-sess");
  // Both sessions should map to chatId 100 in sessionToChat
  expect(bot.sessionToChat.get("old-sess")).toBe(100);
  expect(bot.sessionToChat.get("new-sess")).toBe(100);
});
```

---

### File: `tests/handlers.test.js` — 16 tests

#### `handleUserMessage` — 7 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | Normal message: sets busy, starts typing, sends prompt | Full happy path |
| 2 | Message while busy: queues and sends "Still working" | Queue behavior |
| 3 | Multiple messages while busy: all queued in order | FIFO order |
| 4 | Message while in questionState: routes to `handleCustomQuestionAnswer` | Custom answer flow |
| 5 | Session creation failure: sends error, resets busy | Error recovery |
| 6 | Prompt send failure: sends error message with instructions | "Is OpenCode running?" |
| 7 | Sets `busy = true` before any async work | Race condition prevention |

**Detailed test:**

```js
test("handleUserMessage queues when busy", async () => {
  const state = bot.getState(123);
  state.sessionId = "sess1";
  state.busy = true;

  await bot.handleUserMessage(123, "queued message");

  expect(state.pendingQueue).toEqual(["queued message"]);
  expect(mockBot.sendMessage).toHaveBeenCalledWith(
    123,
    "⏳ Still working on the previous request, I'll reply to this next."
  );
});
```

#### `drainQueue` — 3 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 8 | Empty queue: does nothing | No calls made |
| 9 | Non-empty queue: processes first message | Calls `handleUserMessage` with shifted item |
| 10 | Queue order preserved | FIFO |

#### `handleSessionIdle` — 4 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 11 | Stops typing, sets busy=false | State cleanup |
| 12 | Clears pending permission and question state | Defensive cleanup |
| 13 | Fetches and sends last assistant text | Full happy path |
| 14 | Sends "(no response)" when no text | Edge case |
| 15 | Drains queue after sending response | Queue processing |

#### `handleSessionError` — 2 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 16 | Sends formatted error message and drains queue | Error format with Markdown |

---

### File: `tests/permission.test.js` — 10 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `handlePermissionAsked` sends inline keyboard with 3 buttons | Allow Once, Always Allow, Deny |
| 2 | Message includes permission type | `\`${permission}\`` in text |
| 3 | Message includes command metadata when present | `Command: \`cmd\`` |
| 4 | Message includes path metadata when present | `Path: \`/path\`` |
| 5 | Stores `pendingPermission` with requestId, messageId, timer | State shape |
| 6 | Clears previous pending permission when new one arrives | Replay idempotency |
| 7 | Stops typing then restarts typing | Flow: stop → send message → start |
| 8 | Timeout auto-denies after `INTERACTION_TIMEOUT_MS` | Timer fires, calls `replyPermission("reject")`, removes keyboard |
| 9 | Callback "perm:once" submits correctly | `replyPermission(requestId, "once")` |
| 10 | Callback "perm:reject" submits correctly | `replyPermission(requestId, "reject")` |

**Detailed timeout test:**

```js
test("permission times out and auto-denies", async () => {
  jest.useFakeTimers();
  const req = { id: "perm-1", permission: "file.write", metadata: {} };

  await bot.handlePermissionAsked(123, req);
  expect(bot.getState(123).pendingPermission).not.toBeNull();

  jest.advanceTimersByTime(10 * 60 * 1000); // INTERACTION_TIMEOUT_MS
  await Promise.resolve(); // flush microtasks

  expect(mockBot.editMessageReplyMarkup).toHaveBeenCalledWith(
    { inline_keyboard: [] },
    expect.objectContaining({ chat_id: 123 })
  );
  // replyPermission should have been called with "reject"
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining("/permission/perm-1/reply"),
    expect.objectContaining({ body: JSON.stringify({ reply: "reject" }) })
  );
});
```

---

### File: `tests/question.test.js` — 18 tests

#### `handleQuestionAsked` — 5 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | Single question with options: shows inline keyboard | Buttons = option labels |
| 2 | Single question without options: shows free-text prompt | No keyboard |
| 3 | Multiple questions: shows first question with "1 of N" prefix | Sequential flow |
| 4 | Empty questions array: rejects immediately | Edge case |
| 5 | Clears previous questionState | Replay idempotency |

#### `askCurrentQuestion` — 4 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 6 | Shows "Question X of Y" prefix for multi-question | Prefix format |
| 7 | No prefix for single question | No "1 of 1" |
| 8 | Shows "Or type your own answer" footer when `custom !== false` | Default behavior |
| 9 | No footer when `custom === false` | Restricted to options only |

#### `handleCustomQuestionAnswer` — 2 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 10 | Advances when custom is allowed | Calls `advanceQuestionAnswer` |
| 11 | Rejects when custom is false | Sends "choose one of the options" |

#### `advanceQuestionAnswer` — 4 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 12 | Records answer as `[label]` (array of arrays format) | OpenCode expected format |
| 13 | Advances to next question in multi-question flow | `currentIdx` increments |
| 14 | Submits all answers on last question | Calls `replyQuestion` with full answers array |
| 15 | Clears timer and questionState after submission | Cleanup |

#### Timeout — 1 test

| # | Test Case | What It Verifies |
|---|---|---|
| 16 | Question times out and auto-rejects | `rejectQuestion` called after timeout |

#### Callback handling — 2 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 17 | `qans:` callback with valid state selects correct option | Label lookup from options array |
| 18 | `qans:` callback with stale/missing state sends "reconnecting" message | Graceful degradation |

---

### File: `tests/sse.test.js` — 8 tests

#### `dispatchEvent` — 8 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `permission.asked` dispatches to correct chatId | `sessionToChat` lookup |
| 2 | `question.asked` dispatches to correct chatId | Same |
| 3 | `session.idle` dispatches to correct chatId | Same |
| 4 | `session.error` dispatches to correct chatId | Same |
| 5 | Unknown event type is silently ignored | No crash, no call |
| 6 | Event with unknown sessionId is ignored | No handler called |
| 7 | Event with missing payload is handled safely | No crash |
| 8 | Event with null properties is handled safely | Defensive |

---

### File: `tests/commands.test.js` — 9 tests

#### `/start` — 3 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | Creates session if none exists | Calls `createSession`, sends "Connected to OpenCode!" |
| 2 | Skips creation if already connected | Sends "Already connected!" |
| 3 | Handles error gracefully | Sends error message with URL |

#### `/new` — 3 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 4 | Clears all state for the chat | busy, queue, permission, question, typing all reset |
| 5 | Removes old session from `sessionToChat` | Map cleanup |
| 6 | Creates fresh session | `ensureSession` called |

#### `/abort` — 2 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 7 | Sends abort to OpenCode when busy | `POST /session/:id/abort` |
| 8 | Responds "Nothing running" when not busy | No API call |

#### `/help` — 1 test

| # | Test Case | What It Verifies |
|---|---|---|
| 9 | Sends help text with all commands | Contains `/start`, `/new`, `/abort` |

---

### File: `tests/callbacks.test.js` — 10 tests

#### Permission callbacks — 5 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 1 | `perm:once:id` clears timer + removes keyboard + confirms + calls API | Full happy path |
| 2 | `perm:always:id` shows "Allowed (always)" | Copy check |
| 3 | `perm:reject:id` shows "Denied" | Copy check |
| 4 | Permission callback with no matching in-memory state still works | Post-restart resilience |
| 5 | Permission API error shows failure message | Error handling |

#### Question callbacks — 5 tests

| # | Test Case | What It Verifies |
|---|---|---|
| 6 | `qans:` selects correct option from questionState | Label lookup by index |
| 7 | `qans:` for wrong questionIdx (old button) is ignored | Multi-question guard |
| 8 | `qans:` with invalid optionIdx sends warning | "Invalid option selected" |
| 9 | `qans:` with no in-memory state sends "reconnecting" | Post-restart graceful degradation |
| 10 | `answerCallbackQuery` is always called first | Before any guard |

---

## A.3 — Running the Tests

```bash
# Run all tests
npm test

# Run with coverage
npx jest --coverage --verbose --forceExit

# Run specific test file
npx jest tests/permission.test.js --verbose

# Watch mode during development
npm run test:watch
```

**Expected outcome:** All 105+ tests pass against the **unmodified** `bot.js` (with only the export additions and side-effect guards).

---

## A.4 — jest.config.js

```js
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  setupFilesAfterSetup: [],
  clearMocks: true,
  // Prevent bot.js from starting real polling/SSE
  moduleNameMapper: {},
};
```

---

# PART B — Phased Refactoring

> [!IMPORTANT]
> **Rule for every phase:** After completing the phase, run `npm test`. All 105+ tests MUST continue to pass. If any test fails, fix the refactored code — never modify the test to accommodate the refactor (unless the test was testing implementation details that legitimately changed, in which case document why).

---

## Phase 1 — Extract `config.js` and `utils/logger.js`

### What moves

| From `bot.js` (lines) | To file | Content |
|---|---|---|
| Lines 1-2, 7-17, 19-22 | `src/config.js` | All config loading, validation, constants |
| New | `src/utils/logger.js` | Structured logging wrapper |

### `src/config.js` — Exact Content

```js
"use strict";
require("dotenv").config();

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  openCodeUrl: (process.env.OPENCODE_SERVER_URL || "http://localhost:4096").replace(/\/$/, ""),
  ocUser: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  ocPass: process.env.OPENCODE_SERVER_PASSWORD || "",
  typingIntervalMs: 4000,
  interactionTimeoutMs: 10 * 60 * 1000,
  sseReconnectDelayMs: 3000,
  maxQueueLength: 10,  // NEW: cap for pendingQueue (bug fix)
};

function validate() {
  if (!config.telegramToken || config.telegramToken === "your_telegram_bot_token_here") {
    console.error("[FATAL] Set TELEGRAM_BOT_TOKEN in your .env file");
    process.exit(1);
  }
}

module.exports = { config, validate };
```

### `src/utils/logger.js` — Exact Content

```js
"use strict";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || "info"];

function log(level, tag, message) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${tag}]`;
  if (level === "error") {
    console.error(`${prefix} ${message}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  error: (tag, msg) => log("error", tag, msg),
  warn: (tag, msg) => log("warn", tag, msg),
  info: (tag, msg) => log("info", tag, msg),
  debug: (tag, msg) => log("debug", tag, msg),
};
```

### Changes to `bot.js`

Replace lines 1-17 with:

```js
"use strict";
const { config } = require("./src/config");
const logger = require("./src/utils/logger");

const TELEGRAM_TOKEN = config.telegramToken;
const OPENCODE_URL = config.openCodeUrl;
const OC_USER = config.ocUser;
const OC_PASS = config.ocPass;
const TYPING_INTERVAL_MS = config.typingIntervalMs;
const INTERACTION_TIMEOUT_MS = config.interactionTimeoutMs;
const SSE_RECONNECT_DELAY_MS = config.sseReconnectDelayMs;
```

### Verification

```bash
npm test   # All existing tests must pass
node -e "require('./src/config')"   # No crash
node -e "require('./src/utils/logger').info('TEST', 'hello')"   # Prints log
```

---

## Phase 2 — Extract `src/state/SessionManager.js`

### What moves

| From `bot.js` (lines) | To file | Content |
|---|---|---|
| Lines 44-58 | `SessionManager.js` | `chatState`, `getState` |
| Lines 60-61 | `SessionManager.js` | `sessionToChat` |
| Lines 164-171 | `SessionManager.js` | `ensureSession` |
| Lines 730-758 | `SessionManager.js` | `rehydrateSessions` |

### DRY Fix: `resetInteractions()` method

The repeated cleanup pattern (lines 401-408, 434-441, 667-674, 278-281) becomes one method:

```js
resetInteractions(chatId) {
  const state = this.getState(chatId);
  if (state.pendingPermission) {
    clearTimeout(state.pendingPermission.timer);
    state.pendingPermission = null;
  }
  if (state.questionState) {
    clearTimeout(state.questionState.timer);
    state.questionState = null;
  }
}
```

### DRY Fix: `markIdle()` method

```js
markIdle(chatId) {
  const state = this.getState(chatId);
  state.busy = false;
  this.resetInteractions(chatId);
}
```

### Class Structure

```js
class SessionManager {
  constructor() {
    this.chatState = new Map();
    this.sessionToChat = new Map();
  }
  getState(chatId) { /* same logic as current getState */ }
  resetInteractions(chatId) { /* extracted DRY pattern */ }
  markIdle(chatId) { /* stop busy + reset interactions */ }
  markBusy(chatId) { /* set busy = true */ }
  async ensureSession(chatId, createSessionFn) { /* same logic, takes createSession as param */ }
  async rehydrateSessions(fetchSessionsFn) { /* same logic, takes fetch as param */ }
  resetChat(chatId) { /* full reset for /new command */ }
  queueMessage(chatId, text) { /* push to queue with cap */ }
  dequeueMessage(chatId) { /* shift from queue */ }
}
module.exports = SessionManager;
```

### What changes in `bot.js`

```js
const SessionManager = require("./src/state/SessionManager");
const sessionManager = new SessionManager();

// Replace all getState(chatId) → sessionManager.getState(chatId)
// Replace all chatState.* → sessionManager.chatState.*
// Replace all sessionToChat.* → sessionManager.sessionToChat.*
// Replace all 4 cleanup blocks → sessionManager.resetInteractions(chatId)
```

### Verification

```bash
npm test   # All tests must pass
```

---

## Phase 3 — Extract `src/opencode/OpenCodeClient.js` and `src/bot/messageFormatter.js`

### `src/opencode/OpenCodeClient.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 65-69 | `authHeader()` |
| Lines 71-84 | `ocFetch()` |
| Lines 86-91 | `createSession()` |
| Lines 93-98 | `sendPromptAsync()` |
| Lines 100-110 | `replyPermission()`, `replyQuestion()`, `rejectQuestion()` |
| Lines 113-125 | `fetchLastAssistantText()` |

```js
class OpenCodeClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }
  authHeader() { /* same logic */ }
  async fetch(method, path, body) { /* same as ocFetch */ }
  async createSession(chatId) { /* same */ }
  async sendPromptAsync(sessionId, text) { /* same */ }
  async replyPermission(requestId, reply) { /* same */ }
  async replyQuestion(requestId, answers) { /* same */ }
  async rejectQuestion(requestId) { /* same */ }
  async fetchLastAssistantText(sessionId) { /* same */ }
  async abortSession(sessionId) { /* extract from /abort handler */ }
  async listSessions() { /* extract from rehydrateSessions */ }
}
module.exports = OpenCodeClient;
```

### `src/bot/messageFormatter.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 150-160 | `sendLong()` logic (splitting) |
| New | `escapeMarkdown()` |
| New | `splitSafely()` |

```js
const TELEGRAM_MAX = 4096;

// BUG FIX: Split at last newline before limit, not mid-character
function splitMessage(text, max = TELEGRAM_MAX) {
  if (!text || !text.trim()) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n", max);
    if (splitAt <= 0) splitAt = max; // no newline found, hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ""); // strip leading newline
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

// BUG FIX: Escape Markdown special chars in dynamic content
function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

module.exports = { splitMessage, escapeMarkdown, TELEGRAM_MAX };
```

### Verification

```bash
npm test   # All tests pass
# Some sendLong tests may need adjustment because splitting logic improved
# Update those specific tests to match the new (better) behavior
```

---

## Phase 4 — Extract handlers: `PermissionHandler.js`, `QuestionHandler.js`, `MessageHandler.js`

### `src/handlers/PermissionHandler.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 217-270 | `handlePermissionAsked()` |
| Lines 568-601 of callback handler | Permission callback logic |

```js
class PermissionHandler {
  constructor({ bot, openCodeClient, sessionManager, config }) {
    this.bot = bot;           // Dependency Injection (SOLID: D)
    this.client = openCodeClient;
    this.sessions = sessionManager;
    this.config = config;
  }
  async handleAsked(chatId, req) { /* same as handlePermissionAsked */ }
  async handleCallback(chatId, data, messageId, state) { /* extracted from callback_query */ }
}
```

### `src/handlers/QuestionHandler.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 274-391 | All question functions |
| Lines 604-641 of callback handler | Question callback logic |

```js
class QuestionHandler {
  constructor({ bot, openCodeClient, sessionManager, config }) { /* DI */ }
  async handleAsked(chatId, req) { /* handleQuestionAsked */ }
  async askCurrent(chatId) { /* askCurrentQuestion */ }
  async handleCustomAnswer(chatId, text) { /* handleCustomQuestionAnswer */ }
  async advanceAnswer(chatId, label) { /* advanceQuestionAnswer */ }
  async handleCallback(chatId, data, messageId, state) { /* from callback_query */ }
}
```

### `src/handlers/MessageHandler.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 175-204 | `handleUserMessage` |
| Lines 208-213 | `drainQueue` |
| Lines 395-448 | `handleSessionIdle`, `handleSessionError` |

```js
class MessageHandler {
  constructor({ bot, openCodeClient, sessionManager, questionHandler, messageFormatter }) { /* DI */ }
  async handleUserMessage(chatId, text) { /* same logic */ }
  async drainQueue(chatId) { /* same */ }
  async handleSessionIdle(chatId, sessionId) { /* same, uses sessionManager.markIdle() */ }
  async handleSessionError(chatId, error) { /* same, uses messageFormatter.escapeMarkdown() */ }
}
```

### Verification

```bash
npm test   # All tests pass
```

---

## Phase 5 — Extract `src/opencode/SSEConnection.js` and `src/bot/TelegramBot.js`

### `src/opencode/SSEConnection.js`

| From `bot.js` (lines) | Content |
|---|---|
| Lines 452-497 | `dispatchEvent` |
| Lines 501-553 | `connectSSE` |

```js
class SSEConnection {
  constructor({ openCodeClient, config }) {
    this.client = openCodeClient;
    this.config = config;
    this.handlers = new Map();    // SOLID: O — open for extension
    this.abortController = null;
  }
  on(eventType, handler) { this.handlers.set(eventType, handler); }
  dispatch(event) { /* uses handler registry instead of switch-case */ }
  async connect() { /* same as connectSSE */ }
  disconnect() { /* abort controller */ }
}
```

### `src/bot/TelegramBot.js`

Wraps `node-telegram-bot-api` with safe methods (DRY fix for `.catch(() => {})`):

```js
class TelegramBotWrapper {
  constructor(token) {
    this.bot = new TelegramBot(token, { polling: true });
  }
  // DRY: all 14+ .catch(() => {}) become this ONE method
  async safeSend(chatId, text, opts = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, opts);
    } catch (err) {
      logger.warn("TG", `safeSend failed chatId=${chatId}: ${err.message}`);
      return null;
    }
  }
  async sendLong(chatId, text, opts = {}) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) await this.safeSend(chatId, chunk, opts);
  }
  async safeEditMarkup(markup, opts) { /* same pattern */ }
  async safeSendTyping(chatId) { /* same pattern */ }
  startTyping(chatId, state) { /* extracted from bot.js */ }
  stopTyping(chatId, state) { /* extracted from bot.js */ }
  registerCommand(pattern, handler) { this.bot.onText(pattern, handler); }
  onMessage(handler) { this.bot.on("message", handler); }
  onCallbackQuery(handler) { this.bot.on("callback_query", handler); }
  stop() { this.bot.stopPolling(); }
}
```

### Verification

```bash
npm test   # All tests pass
```

---

## Phase 6 — Create `src/index.js` (Composition Root) and remove `bot.js`

### `src/index.js` — Wires Everything Together

```js
"use strict";
const { config, validate } = require("./config");
validate();

const logger = require("./utils/logger");
const TelegramBotWrapper = require("./bot/TelegramBot");
const OpenCodeClient = require("./opencode/OpenCodeClient");
const SSEConnection = require("./opencode/SSEConnection");
const SessionManager = require("./state/SessionManager");
const PermissionHandler = require("./handlers/PermissionHandler");
const QuestionHandler = require("./handlers/QuestionHandler");
const MessageHandler = require("./handlers/MessageHandler");

// Instantiate
const bot = new TelegramBotWrapper(config.telegramToken);
const client = new OpenCodeClient(config);
const sessionManager = new SessionManager();
const sseConnection = new SSEConnection({ openCodeClient: client, config });

const permissionHandler = new PermissionHandler({ bot, openCodeClient: client, sessionManager, config });
const questionHandler = new QuestionHandler({ bot, openCodeClient: client, sessionManager, config });
const messageHandler = new MessageHandler({ bot, openCodeClient: client, sessionManager, questionHandler });

// Register SSE event handlers (SOLID: O — Open/Closed)
sseConnection.on("permission.asked", (props) => { /* route to permissionHandler */ });
sseConnection.on("question.asked", (props) => { /* route to questionHandler */ });
sseConnection.on("session.idle", (props) => { /* route to messageHandler */ });
sseConnection.on("session.error", (props) => { /* route to messageHandler */ });

// Register Telegram commands
bot.registerCommand(/\/start/, (msg) => { /* same logic as current /start */ });
bot.registerCommand(/\/new/, (msg) => { /* same, uses sessionManager.resetChat() */ });
bot.registerCommand(/\/abort/, (msg) => { /* same */ });
bot.registerCommand(/\/help/, (msg) => { /* same */ });

// Register message + callback handlers
bot.onMessage((msg) => { /* route to messageHandler */ });
bot.onCallbackQuery((query) => { /* route to permissionHandler or questionHandler */ });

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("SHUTDOWN", "Stopping bot...");
  sseConnection.disconnect();
  bot.stop();
  process.exit(0);
});

process.on("uncaughtException", (err) => logger.error("UNCAUGHT", `${err.message}\n${err.stack}`));
process.on("unhandledRejection", (reason) => logger.error("UNHANDLED", String(reason)));

// Startup
logger.info("BOT", `Starting OpenCode Telegram Bot`);
logger.info("BOT", `OpenCode server: ${config.openCodeUrl}`);
sessionManager.rehydrateSessions(() => client.listSessions()).then(() => sseConnection.connect());
```

### Update `package.json`

```json
"scripts": {
  "start": "node src/index.js",
  "start:legacy": "node bot.js",
  "test": "jest --verbose --forceExit"
}
```

### Keep `bot.js` as backup

Rename to `bot.legacy.js` or keep as-is. The `start:legacy` script allows instant rollback.

### Final Verification

```bash
npm test                    # All tests pass
npm start                   # Bot starts, connects to OpenCode
# Manual: test /start, /new, /help, /abort, send message, permission, question flows
```

---

## Verification Plan Summary

| Phase | Tests Command | What Must Pass |
|---|---|---|
| A (tests) | `npm test` | All 105+ tests pass against original `bot.js` |
| Phase 1 | `npm test` | All tests + `config.js` + `logger.js` work |
| Phase 2 | `npm test` | All tests + `SessionManager` extractions work |
| Phase 3 | `npm test` | All tests + `OpenCodeClient` + `messageFormatter` work |
| Phase 4 | `npm test` | All tests + all 3 handlers extracted |
| Phase 5 | `npm test` | All tests + SSE + TelegramBot wrapper work |
| Phase 6 | `npm test` | All tests pass via `src/index.js`, `bot.js` kept as backup |

> [!CAUTION]
> At **no point** do we delete `bot.js` until you are fully confident the refactored version is stable. It stays as `bot.js` (or `bot.legacy.js`) with a `npm run start:legacy` escape hatch.
