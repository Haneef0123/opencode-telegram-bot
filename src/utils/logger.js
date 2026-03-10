"use strict";

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || "info"];

function log(level, tag, message) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${tag}]`;

  if (level === "error") {
    console.error(`${prefix} ${message}`);
    return;
  }
  if (level === "warn") {
    console.warn(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`);
}

module.exports = {
  error: (tag, msg) => log("error", tag, msg),
  warn: (tag, msg) => log("warn", tag, msg),
  info: (tag, msg) => log("info", tag, msg),
  debug: (tag, msg) => log("debug", tag, msg),
};
