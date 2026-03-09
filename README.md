# OpenCode Telegram Bot

A simple Telegram bot that bridges Telegram messages to your local OpenCode AI session.

## Setup

### 1. Get a Telegram Bot Token
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the token you receive

### 2. Configure the bot
```bash
cp .env.example .env
```
Edit `.env` and paste your token:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
OPENCODE_SERVER_URL=http://localhost:4096
```

### 3. Start OpenCode server
In a separate terminal:
```bash
opencode serve
```

### 4. Start the bot
```bash
npm start
```

## Usage

Open your bot on Telegram and:

| Command | Description |
|---------|-------------|
| `/start` | Connect and start a session |
| `/new` | Start a fresh session |
| `/help` | Show help |
| Any message | Chat with the AI |

## How it works

```
Telegram User → Telegram Bot API → bot.js → OpenCode HTTP API → AI Response → back to Telegram
```

Each Telegram chat gets its own OpenCode session, so conversations are isolated per user.
