"use strict";

const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..", "..");
require("dotenv").config({ path: path.join(projectRoot, ".env"), quiet: true });

function fail(message, helpLines = []) {
  console.error(`[LIVE-E2E] ${message}`);
  for (const line of helpLines) {
    console.error(line);
  }
  process.exit(2);
}

function checkRequiredEnv() {
  const required = ["TELEGRAM_BOT_TOKEN", "TG_API_ID", "TG_API_HASH"];
  const missing = required.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length) {
    fail(
      `Missing required env: ${missing.join(", ")}`,
      [
        "[LIVE-E2E] Update /Users/haneefshaikh/opencode-telegram-bot/.env and rerun.",
      ]
    );
  }

  if (!process.env.TG_STRING_SESSION || !String(process.env.TG_STRING_SESSION).trim()) {
    fail(
      "Missing required env: TG_STRING_SESSION",
      [
        "[LIVE-E2E] Run session generator once:",
        "node skills/telegram-live-e2e/scripts/generate-string-session.js",
        "[LIVE-E2E] Then set TG_STRING_SESSION in .env and rerun this command.",
      ]
    );
  }
}

function run() {
  checkRequiredEnv();

  const scriptPath = path.join(__dirname, "live-comprehensive-telegram-e2e.js");
  const child = spawn(process.execPath, [scriptPath], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, PROJECT_ROOT: projectRoot },
  });

  child.on("error", (err) => {
    fail(`Failed to launch live suite: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[LIVE-E2E] Exited via signal: ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

run();
