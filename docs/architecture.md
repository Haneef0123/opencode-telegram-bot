# Architecture

## Overview

The bot bridges Telegram and OpenCode by acting as a thin translation layer. A user sends messages in Telegram; the bot forwards them to OpenCode via HTTP, then streams AI responses and interactive prompts back to the user in real time.

```
User (Telegram)
      │  messages / button taps
      ▼
node-telegram-bot-api (long polling)
      │  commands, text, callback_query
      ▼
bot.js (state machine per chatId)
      │  POST /session/:id/prompt_async
      │  POST /permission/:id/reply
      │  POST /question/:id/reply
      ▼
OpenCode HTTP server  (localhost:4096)
      │  GET /global/event  (SSE stream)
      ▼
bot.js SSE dispatcher
      │  session.idle → send AI reply
      │  session.error → send error message
      │  permission.asked → send inline keyboard
      │  question.asked → send inline keyboard / free-text prompt
      ▼
User (Telegram)
```

---

## Components

### 1. Telegram polling

`new TelegramBot(token, { polling: true })` opens a long-poll connection to Telegram's `getUpdates` API. All incoming `message` and `callback_query` updates are delivered here.

Relevant handlers registered on the bot object:

| Handler | Trigger |
|---|---|
| `bot.on("message")` | Any text message from the user |
| `bot.on("callback_query")` | Button tap on an inline keyboard |
| `bot.onText(/\/start/)` | `/start` command |
| `bot.onText(/\/new/)` | `/new` command — fresh session |
| `bot.onText(/\/abort/)` | `/abort` command — cancel current task |
| `bot.onText(/\/help/)` | `/help` command |

### 2. Per-chat state (`chatState` Map)

All runtime state is keyed by `chatId` (Telegram numeric chat ID). Each entry holds:

```
{
  sessionId: string | null,      // active OpenCode session ID
  busy: boolean,                 // true while AI is processing
  pendingQueue: string[],        // messages queued while busy
  typingTimer: Timeout | null,   // handle for the typing-indicator loop
  pendingPermission: {           // set when a permission.asked event arrives
    requestId, messageId, timer
  } | null,
  questionState: {               // set when a question.asked event arrives
    requestId,
    questions[],                 // full question objects from OpenCode
    answers[],                   // collected so far (array of arrays)
    currentIdx,                  // which question we are on
    timer                        // auto-reject timeout handle
  } | null,
}
```

### 3. Session map (`sessionToChat` Map)

A reverse-lookup map from OpenCode `sessionId` → Telegram `chatId`. This is needed because SSE events carry `sessionID` but not `chatId`.

Populated in two ways:
- **At runtime**: `ensureSession()` creates a new session and immediately registers it.
- **At startup**: `rehydrateSessions()` fetches all sessions from `GET /session`, finds any titled `"Telegram Chat <chatId>"`, and registers all of them. This ensures events for sessions from previous bot runs are still routable after a restart.

### 4. OpenCode HTTP client (`ocFetch`)

A thin `fetch` wrapper that adds Basic Auth (`opencode:village`) and JSON parse/error handling. Used for all REST calls:

| Call | Purpose |
|---|---|
| `POST /session` | Create a new session |
| `POST /session/:id/prompt_async` | Send user message (fire-and-forget, 204) |
| `POST /session/:id/abort` | Cancel current task |
| `GET /session/:id/message` | Fetch message history to extract AI reply text |
| `GET /session` | List all sessions (used at startup for rehydration) |
| `POST /permission/:id/reply` | Respond to a permission request |
| `POST /question/:id/reply` | Submit question answers |
| `POST /question/:id/reject` | Reject/skip a question |

### 5. SSE listener (`connectSSE`)

A persistent `fetch` to `GET /global/event` with `Accept: text/event-stream`. Reads the response body as a stream, splits on newlines, and parses each `data:` line as JSON.

On any error or stream close it reconnects after `SSE_RECONNECT_DELAY_MS` (3 s). An `AbortController` is used to cleanly cancel on shutdown.

Dispatched event types:

| Event | Action |
|---|---|
| `permission.asked` | Show inline keyboard with Allow Once / Always / Deny |
| `question.asked` | Show inline keyboard (if options) or free-text prompt |
| `session.idle` | Fetch final assistant text, send to user, drain queue |
| `session.error` | Send error message to user, drain queue |
| All others | Silently ignored |

Any event whose `sessionID` is not in `sessionToChat` is logged and ignored.

### 6. Interaction flow

**Busy guard / queue**

When a message arrives while `busy=true`, it is pushed onto `pendingQueue` and the user is informed. After `session.idle` or `session.error`, `drainQueue()` picks the next message and processes it.

**Permission flow**

```
permission.asked (SSE)
  → stopTyping
  → sendMessage with inline_keyboard [Allow Once | Always Allow | Deny]
  → store { requestId, messageId, timer } in state.pendingPermission
  → startTyping (show AI is still working)

callback_query  data="perm:<reply>:<requestId>"
  → answerCallbackQuery (remove spinner)
  → clear in-memory timer if present
  → editMessageReplyMarkup (remove buttons)
  → sendMessage confirmation
  → POST /permission/:id/reply
  → startTyping
```

**Question flow**

```
question.asked (SSE)
  → stopTyping
  → store full question data in state.questionState
  → send question text + inline_keyboard (one button per option)

callback_query  data="qans:<requestId>:<questionIdx>:<optionIdx>"
  → look up label from state.questionState.questions[questionIdx].options[optionIdx]
  → editMessageReplyMarkup (remove buttons)
  → sendMessage "Selected: <label>"
  → advanceQuestionAnswer → if more questions, send next; else POST /question/:id/reply

text message (while questionState is set)
  → handleCustomQuestionAnswer → advanceQuestionAnswer with raw text
```

**Typing indicator**

`startTyping` sends `sendChatAction("typing")` immediately and schedules a `setTimeout` every 4 s to refresh it (Telegram clears the indicator after 5 s). `stopTyping` cancels the timer.

### 7. Startup sequence

```
1. rehydrateSessions()   — register all prior Telegram sessions
2. connectSSE()          — open SSE stream
3. (TelegramBot polling already active from constructor)
```

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather (required) |
| `OPENCODE_SERVER_URL` | `http://localhost:4096` | OpenCode server base URL |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic Auth username |
| `OPENCODE_SERVER_PASSWORD` | `` | HTTP Basic Auth password |

---

## Constants

| Constant | Value | Purpose |
|---|---|---|
| `TYPING_INTERVAL_MS` | 4000 ms | Typing indicator refresh rate (must be < 5000) |
| `INTERACTION_TIMEOUT_MS` | 10 min | Auto-reject stale permission / question |
| `SSE_RECONNECT_DELAY_MS` | 3000 ms | Delay before reconnecting SSE after error |

---

## Key design decisions

**Fire-and-forget prompt**: `prompt_async` returns 204 immediately. The AI reply arrives later via `session.idle`. This is essential — a synchronous call would block for the full AI generation time and hit HTTP timeouts.

**OpenCode is the authority on request validity**: The callback handlers do not reject a button tap just because in-memory state is absent. They submit to OpenCode and let OpenCode return an error if the request ID is stale. This makes the bot resilient to restarts.

**Option index in `callback_data`, not label text**: Telegram enforces a 64-byte hard limit on `callback_data`. Option labels can be long. The bot encodes the option's array index (`qans:<requestId>:<qIdx>:<optIdx>`) and resolves the label from `questionState.questions` at callback time.

**Session title convention**: Sessions created by the bot are titled `"Telegram Chat <chatId>"`. This is how `rehydrateSessions()` identifies and re-registers them after a restart.
