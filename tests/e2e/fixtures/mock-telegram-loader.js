"use strict";

const Module = require("module");
const path = require("path");

// Shorten long waits for deterministic E2E runtime.
const originalSetTimeout = global.setTimeout;
global.setTimeout = (fn, delay, ...args) => {
  let effectiveDelay = delay;
  if (delay === 10 * 60 * 1000) effectiveDelay = 120; // interaction timeout
  if (delay === 3000) effectiveDelay = 80; // SSE reconnect
  return originalSetTimeout(fn, effectiveDelay, ...args);
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node-telegram-bot-api") {
    return originalLoad(path.join(__dirname, "mock-telegram-bot-api.js"), parent, isMain);
  }
  return originalLoad(request, parent, isMain);
};
