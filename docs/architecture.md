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
| `bot.onText(/\/model/)` | `/model` command — open model picker |
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
  selectedModel: string | null,  // "providerId/modelId" chosen via /model,
                                 // null means use OpenCode server default
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
| `GET /provider` | List all providers and models (used by `/model` command) |
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

### 6. Model selection

The `/model` command lets users choose which AI model to use for their chat session. The selection is stored in `state.selectedModel` as a `"providerId/modelId"` string (e.g. `"anthropic/claude-sonnet-4-6"`) and is passed to every subsequent `prompt_async` call.

#### Picker layout (paginated)

Because a provider can have many models (Anthropic has 23, GitHub Copilot has 24), the keyboard is paginated: **8 models per page** per provider, with provider tabs at the top for instant switching.

```
[● Anthropic]  [GitHub Copilot]  [OpenCode Zen]   ← provider tab row (row 0)
── Anthropic — page 1/3 ──                         ← separator (model_noop)
Claude Opus 4.5
Claude Sonnet 4.6 ✓                                ← ✓ = currently active
Claude Haiku 4.5
...  (up to 8 models)
[  ‹ Prev  ]  [ 1 / 3 ]  [ Next › ]               ← nav row (only when >1 page)
[↩ Use OpenCode default]                           ← reset row
```

#### callback_data prefixes

| Prefix | Format | Action |
|---|---|---|
| `mprov:` | `mprov:<providerIdx>` | Switch to that provider tab, reset to page 0 |
| `mpage:` | `mpage:<providerIdx>:<page>` | Navigate to a specific page within the current provider |
| `model:` | `model:<providerId>/<modelId>` | Select a model and persist it to `state.selectedModel` |
| `model:default` | — | Clear `state.selectedModel` (revert to OpenCode default) |
| `model_noop` | — | Non-interactive label/spacer — silently ignored |

All values stay well under Telegram's 64-byte `callback_data` hard limit (worst case: `model:anthropic/claude-opus-4-5-20251101` = 40 bytes).

#### Full interaction flow

```
/model command
  → GET /provider
  → filter to connected providers, normalise models dict → array
  → buildModelKeyboard(state, providerIdx=0, page=0)
  → sendMessage with paginated keyboard

callback_query  data="mprov:<idx>"
  → sendModelPicker(chatId, state, messageId, idx, 0)
  → editMessageText in-place — tab row updates: ● moves to new provider

callback_query  data="mpage:<providerIdx>:<page>"
  → sendModelPicker(chatId, state, messageId, providerIdx, page)
  → editMessageText in-place — model list + nav row update

callback_query  data="model:<provider>/<modelId>"
  → state.selectedModel = "provider/modelId"
  → buildModelPickerText(state)  — header reflects new selection
  → buildModelKeyboard(state)    — ✓ moves to newly selected model
  → editMessageText in-place
  → answerCallbackQuery toast: "Switched to <modelId>"

callback_query  data="model:default"
  → state.selectedModel = null
  → editMessageText in-place — header reverts to server default or "OpenCode default"
  → answerCallbackQuery toast: "Reset to OpenCode default"

Each subsequent prompt_async
  → if state.selectedModel is set:
      split "provider/model" at first /
      include { providerID, modelID } object in request body
  → AI response footer shows "_Model: provider/modelId_" when a model is selected
```

#### Provider/model data shape from OpenCode

`GET /provider` returns:
```json
{
  "all": [ { "id": "anthropic", "name": "Anthropic", "models": { "claude-sonnet-4-6": { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" } } } ],
  "connected": ["anthropic", "github-copilot", "opencode"],
  "default": { "anthropic": "claude-sonnet-4-6", "opencode": "big-pickle", ... }
}
```

Key details:
- `models` is a **dict** keyed by model ID, not an array. `fetchProviders()` normalises it to an array via `Object.values()`.
- `connected` is the list of providers that have API keys configured — only these are shown in the picker.
- `default` is a dict of `{ providerId: defaultModelId }` — one default per provider. The displayed "current model" uses the first connected provider's default when `selectedModel` is `null`.
- `prompt_async` requires model as an object `{ providerID, modelID }`, not a plain string. The bot splits its internal `"provider/model"` string at the first `/` before sending.

#### Constants

| Constant | Value | Purpose |
|---|---|---|
| `MODELS_PER_PAGE` | 8 | Number of model buttons shown per page per provider |

### 8. Interaction flow

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

### 9. Startup sequence

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

**Model selection is per-chat, in-memory only**: `state.selectedModel` is not persisted to disk or to any OpenCode session field. It resets to `null` (OpenCode default) if the bot restarts or the user runs `/new`. This is intentional — the OpenCode server is the authority on available models; we never cache the model list.

**Model passed as object, not string**: `prompt_async` requires `model: { providerID, modelID }`. The bot stores the selection internally as `"provider/model"` for compactness and splits it at the `/` boundary before every API call.

**`/model` picker edits in place**: Every interaction (tab switch, page nav, model select, reset) calls `editMessageText` on the same message rather than sending a new one. This keeps the chat clean — there is always exactly one picker message, which updates in place.

**Pagination state is not stored in `chatState`**: The current provider tab and page number are encoded directly in the `callback_data` of the navigation buttons (`mprov:<idx>` and `mpage:<providerIdx>:<page>`). There is nothing to persist or rehydrate — each button tap is self-contained and carries all the context needed to rebuild the correct keyboard view.

**Provider tab switching always resets to page 0**: When a user switches providers via a tab button (`mprov:<idx>`), pagination resets to the first page of the new provider. This avoids the edge case of landing on a non-existent page (e.g. provider A has 3 pages but provider B only has 1).
