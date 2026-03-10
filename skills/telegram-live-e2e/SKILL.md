---
name: telegram-live-e2e
description: Run comprehensive live end-to-end testing for the Telegram bot using a real Telegram user session and a deterministic OpenCode test backend. Use when asked to run real Telegram flows, verify commands/permissions/questions/timeout/abort/reconnect/rehydration, or reproduce live bot behavior with visible chat messages.
---

# Telegram Live E2E

Use this skill to run a comprehensive live test of `bot.js` where messages are sent through real Telegram chat.

## When to use

- User asks for real Telegram testing (not mocks).
- Need visible in-chat evidence for command and callback flows.
- Need deterministic validation of edge cases while preserving real Telegram transport.

## Quick Start (Recommended)

From repo root:

```bash
node skills/telegram-live-e2e/scripts/run-live-comprehensive-telegram-e2e.js
```

This wrapper does preflight checks for required env vars and then runs the full live suite.

## Prerequisites

- Run from repo root: `/Users/haneefshaikh/opencode-telegram-bot`.
- `.env` contains:
  - `TELEGRAM_BOT_TOKEN`
  - `TG_API_ID`
  - `TG_API_HASH`
  - `TG_STRING_SESSION` (or generate it first)
- `telegram` package installed (`npm i -D telegram` if missing).

## One-time session generation

If `TG_STRING_SESSION` is missing:

```bash
node skills/telegram-live-e2e/scripts/generate-string-session.js
```

- Provide OTP and optional 2FA password when prompted.
- Add printed value to `.env`:
  - `TG_STRING_SESSION=...`

## Run Suite (Direct)

If you want to bypass wrapper checks:

```bash
node skills/telegram-live-e2e/scripts/live-comprehensive-telegram-e2e.js
```

What this does:
- Starts an in-process deterministic OpenCode test backend (HTTP + SSE).
- Starts real `bot.js` process with accelerated timeout/reconnect for test runtime.
- Uses real Telegram user session to message the bot.
- Executes and validates end-to-end flows with tagged messages (`[LIVE-E2E-<timestamp>]`).
- Prints machine-readable JSON report with per-step pass/fail.

## Flows covered

- `/help`, `/start`, `/new`
- Busy queue + FIFO drain
- Permission callback approve
- Permission timeout auto-deny
- Question option callback
- Question custom free-text
- Question custom-disallowed guard
- Question timeout reject
- No-response fallback
- Bad message-fetch fallback
- Long-response chunking
- `/abort` idle and busy
- `session.error` handling
- SSE reconnect
- Rehydration after bot restart

## Troubleshooting

- `listen EPERM` on localhost during tests:
  - Environment/sandbox blocked local bind.
  - Re-run with permissions that allow local server sockets.
- `ENOTFOUND api.telegram.org` / Telegram connect EPERM:
  - Environment/sandbox blocked outbound network.
  - Re-run with outbound network enabled.
- `409 Conflict: terminated by other getUpdates request`:
  - Another bot instance is running with same token.
  - Stop competing process and rerun.
- `Missing env TG_STRING_SESSION`:
  - Run session generator script again.
- Flood wait warnings from Telegram:
  - Script retries by polling; allow it to complete.

## Reporting format

After run, report:
- `passed` boolean
- Failed steps (if any) with error
- Tag used (`[LIVE-E2E-...]`) so user can find messages in chat
- Any caveats (`409`, flood wait, session issues)

## Agent workflow notes

- Always run this suite after major bot behavior changes.
- Use wrapper command first; only use direct script command for debugging.
- If flood wait appears, let run continue; script retries automatically.
