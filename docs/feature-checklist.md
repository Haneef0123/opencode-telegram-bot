# Feature Development Checklist

Follow these steps every time a new feature is added to the bot. They encode the hard lessons from every bug we have already hit.

---

## Step 1 — Understand where state lives

Before writing a single line of code, answer these questions:

- Does the feature introduce new **in-memory state** on `chatState`?
- Does that state need to survive a **bot restart**? If yes, plan for rehydration.
- Does the feature create new **OpenCode objects** (sessions, requests)? If yes, does `sessionToChat` or an equivalent map need to be updated?
- Is any state keyed by a Telegram `messageId`? Those are stable across restarts. Is any state keyed by a request ID that could expire on the OpenCode side?

**Rule**: Never assume in-memory state exists when processing a Telegram callback. Always treat its absence as a valid, recoverable situation — not an error.

---

## Step 2 — Audit every `callback_data` string

Telegram enforces a **64-byte hard limit** on `callback_data`. Before sending any inline keyboard:

1. Enumerate the worst-case values of every variable in the `callback_data` string.
2. Count the bytes. If there is any risk of exceeding 64 bytes, encode an **index** instead of the raw value and look up the value from in-memory state at callback time.
3. Write a comment next to the `callback_data` string showing the byte count of the longest realistic value.

```js
// "perm:always:per_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" = 12 + 30 = 42 bytes — safe
callback_data: `perm:${reply}:${requestId}`

// "qans:que_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:0:0" = 5 + 30 + 4 = 39 bytes — safe
// Using option INDEX, not label text, to avoid label length blowing the limit
callback_data: `qans:${requestId}:${questionIdx}:${optionIdx}`
```

---

## Step 3 — Never guard callbacks purely on in-memory state

The pattern below **will break every time the bot restarts** while a button is visible to the user:

```js
// WRONG — blocks all taps after restart
if (!state.somePendingThing || state.somePendingThing.requestId !== id) {
  sendMessage("No longer active");
  return;
}
```

The correct pattern is:

```js
// RIGHT — clean up in-memory state if present, then proceed to call the server
if (state.somePendingThing?.requestId === id) {
  clearTimeout(state.somePendingThing.timer);
  state.somePendingThing = null;
}
// Always attempt the server call — let the server reject if the request is stale
await callServer(id, ...);
```

**Rule**: The server (OpenCode) is the authority on whether a request ID is still valid. The bot is not. The bot's in-memory state is only a cache.

---

## Step 4 — Register new session types in rehydrateSessions

If the feature creates OpenCode sessions with a new naming convention (or any other identifiable title pattern), extend `rehydrateSessions()` to recognise and re-register them at startup.

Current pattern matched: `"Telegram Chat <chatId>"`.

If a new feature creates sessions titled differently (e.g. `"Group <groupId>"` or `"Channel <channelId>"`), add a new regex match block inside `rehydrateSessions()`.

---

## Step 5 — Log before every early return

Any `return` that silently discards an event or callback must be preceded by a log line. Silent discards are the hardest class of bug to diagnose.

```js
// WRONG
if (!chatId) return;

// RIGHT
if (!chatId) {
  log("CALLBACK", `no chatId on callback data="${data}" — ignoring`);
  return;
}
```

Apply this rule to:
- SSE event dispatch (unknown sessionID)
- Callback handler guards
- Any async function that bails out early based on a state check

---

## Step 6 — Add a `[CALLBACK] RECEIVED` log at the top of any new callback handler

The very first line inside any `callback_query` (or future `inline_query`, `poll_answer`, etc.) handler must log all identifying fields unconditionally, before any guard:

```js
bot.on("callback_query", async (query) => {
  log("CALLBACK", `RECEIVED chatId=${chatId} data="${data}" from=${query.from?.id}`);
  bot.answerCallbackQuery(query.id).catch(() => {}); // always answer immediately
  // ... guards below
});
```

This makes it immediately obvious whether Telegram is delivering the update at all, independent of any logic bug.

---

## Step 7 — Handle the SSE replay scenario

OpenCode replays recent events when a new SSE client connects. Any new event type the feature introduces must be idempotent when received multiple times:

- Check whether the state it would create already exists.
- If it does and it matches (same requestId), skip re-sending the Telegram message to avoid duplicates.
- If it does and it does not match (different requestId), clear the old state first.

Example pattern from `handleQuestionAsked`:
```js
if (state.questionState) {
  clearTimeout(state.questionState.timer); // clear old before overwriting
  state.questionState = null;
}
// now set fresh state
```

---

## Step 8 — Always `answerCallbackQuery` immediately

Every `callback_query` handler must call `bot.answerCallbackQuery(query.id)` as the first async operation, before any await that could fail. Failing to answer leaves the user with a spinning loading indicator on the button indefinitely.

```js
bot.answerCallbackQuery(query.id).catch(() => {}); // swallow — non-critical
```

---

## Step 9 — Test the restart scenario explicitly

Before considering a feature done, manually test this sequence:

1. Trigger the feature — confirm the button/prompt appears in Telegram.
2. Kill the bot process (`kill <pid>`).
3. Restart the bot.
4. Tap the button / send the reply in Telegram.
5. Confirm the action is submitted to OpenCode and the flow continues.

If step 5 fails, go back to Steps 3 and 4.

---

## Step 10 — Handle the "busy" state correctly

Any new path that accepts user input must check `state.busy` and queue appropriately, or explicitly document why it bypasses the queue.

Paths that should **bypass** the busy queue:
- Permission button taps (must be answered immediately; OpenCode is paused waiting)
- Question button taps (same reason)
- `/abort` command

Paths that should **respect** the busy queue:
- New user messages
- Any future command that starts a new AI task

---

## Quick reference checklist

```
[ ] No callback_data exceeds 64 bytes (worst-case counted, comment added)
[ ] No callback guard relies solely on in-memory state being non-null
[ ] New sessions registered in rehydrateSessions() if they need post-restart routing
[ ] Every early return has a log line
[ ] callback_query handler logs RECEIVED unconditionally as first line
[ ] answerCallbackQuery called before any awaitable that could throw
[ ] SSE event handler is idempotent (handles replay without sending duplicates)
[ ] Restart scenario tested manually end-to-end
[ ] New user-input path respects or explicitly bypasses the busy queue
```
