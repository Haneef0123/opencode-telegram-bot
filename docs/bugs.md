# Bugs Encountered

A chronological record of every bug found and fixed during development of the OpenCode Telegram bot.

---

## Bug 1 — Blocking architecture caused HTTP timeouts

**Symptom**: Bot sent a prompt to OpenCode and waited for the response synchronously. OpenCode AI tasks can take minutes; the HTTP request timed out before the response arrived.

**Root cause**: The original design used a single synchronous `POST /session/:id/prompt` call and waited for the body to contain the full AI reply.

**Fix**: Switched to the event-driven architecture:
- `POST /session/:id/prompt_async` — fire-and-forget, returns 204 immediately.
- `GET /global/event` (SSE stream) — delivers `session.idle` when the AI finishes, at which point the bot fetches the final text via `GET /session/:id/message`.

---

## Bug 2 — `callback_data` exceeded Telegram's 64-byte hard limit

**Symptom**: Inline keyboard buttons for questions were silently broken. Telegram rejects any message with a button whose `callback_data` exceeds 64 bytes. The send call appeared to succeed but the buttons did not work.

**Root cause**: The original `callback_data` for question options encoded the full option label text:

```
qans:<requestId>:<questionIdx>:<labelText>
```

Some labels (e.g. `"Email & password"`, long workspace URLs) pushed the string over 64 bytes.

**Fix**: Encode the option's **array index** instead of the label text:

```
qans:<requestId>:<questionIdx>:<optionIdx>
```

The label is then looked up from `state.questionState.questions[questionIdx].options[optionIdx]` at callback time. Request IDs are ~30 characters; even with the prefix and indices the string stays well under 64 bytes.

---

## Bug 3 — Session ID mismatch after bot restart lost SSE event routing

**Symptom**: After the bot was restarted, `question.asked` and `permission.asked` SSE events were silently dropped. The log showed "unknown sessionID — ignoring" for sessions that the bot had previously created.

**Root cause**: The `sessionToChat` map (`sessionId → chatId`) is in-memory and is lost on restart. OpenCode replays recent events (including pending `question.asked` and `permission.asked`) when a new SSE client connects, but the new bot instance had no mapping for those session IDs.

**Fix**: Added `rehydrateSessions()`, called at startup before `connectSSE()`. It calls `GET /session`, finds every session whose title matches `"Telegram Chat <chatId>"`, and re-registers all of them into `sessionToChat`. It also restores `chatState.sessionId` to the most recently updated session per chat.

```js
async function rehydrateSessions() {
  const sessions = await ocFetch("GET", "/session");
  for (const s of sessions) {
    const match = s.title?.match(/^Telegram Chat (-?\d+)$/);
    if (!match) continue;
    const chatId = parseInt(match[1], 10);
    sessionToChat.set(s.id, chatId);
    // ... also update chatState.sessionId to newest
  }
}
```

---

## Bug 4 — Permission callback rejected every tap after restart

**Symptom**: User tapped "Allow Once" or "Deny" on a permission request. Nothing happened — the bot silently rejected the tap. The session then timed out or was auto-denied.

**Root cause**: The callback handler guarded against stale taps by checking in-memory state:

```js
if (!state.pendingPermission || state.pendingPermission.requestId !== requestId) {
  editMessage("⚠️ This permission request is no longer active.");
  return;
}
```

After a restart, `state.pendingPermission` is always `null`. Every permission button tap was rejected before even attempting to call OpenCode.

**Fix**: Removed the guard entirely. The callback now:
1. Clears the in-memory timer if it happens to match (best-effort).
2. Removes the inline keyboard and sends a confirmation message.
3. Calls `POST /permission/:id/reply` directly — OpenCode is the authority on whether the `requestId` is still valid and will return an error if it is stale.

```js
// Before (broken after restart)
if (!state.pendingPermission || state.pendingPermission.requestId !== requestId) {
  return; // ← blocked all taps after restart
}

// After (resilient)
if (state.pendingPermission?.requestId === requestId) {
  clearTimeout(state.pendingPermission.timer);
  state.pendingPermission = null;
}
// proceed to call OpenCode regardless
await replyPermission(requestId, reply);
```

---

## Bug 5 — Question callback rejected every tap after restart

**Symptom**: Same class of bug as Bug 4 but for question buttons. Tapping a question option after a bot restart showed "This question is no longer active" and did not submit the answer.

**Root cause**: Same pattern — the callback guarded on `state.questionState`:

```js
if (!state.questionState || state.questionState.requestId !== requestId) {
  editMessage("⚠️ This question is no longer active.");
  return;
}
```

After a restart, `state.questionState` is `null` and every question button tap was blocked.

**Fix**: Made the handler two-path:
1. **In-memory state matches** → look up the label from stored questions, submit normally. This is the normal (no-restart) path.
2. **In-memory state absent** → tell the user to wait. OpenCode replays the `question.asked` event on SSE reconnect, which restores `questionState`. The user can then tap again.

The hard constraint here is that option labels cannot be recovered without `questionState` because:
- The `callback_data` only stores the option index, not the label (see Bug 2).
- OpenCode has no `GET /question/:id` endpoint to re-fetch the question data.
- SSE replay of `question.asked` is the correct recovery path.

---

## Bug 6 — Unknown session events silently dropped with no diagnostic

**Symptom**: SSE events for sessions not in `sessionToChat` were silently ignored with a bare `return`. When debugging routing failures, there was no way to know which session IDs were being dropped or why.

**Fix**: Added an explicit log line before returning:

```js
if (!chatId) {
  log("SSE", `question.asked: unknown sessionID=${props.sessionID} — ignoring`);
  return;
}
```

Applied to all four event types: `permission.asked`, `question.asked`, `session.idle`, `session.error`.

---

## Bug 7 — Missing `[CALLBACK]` log made it impossible to tell if button taps were received

**Symptom**: During debugging it was unclear whether Telegram was delivering `callback_query` updates to the bot at all, since no log line fired inside the handler unless the data matched a known prefix.

**Fix**: Added a log line at the very top of the `callback_query` handler, before any guards:

```js
log("CALLBACK", `RECEIVED chatId=${chatId} messageId=${messageId} data="${data}" from=${query.from?.id}`);
```

Also added a log showing the current `questionState` at the moment of the tap, making requestId mismatches immediately visible.
