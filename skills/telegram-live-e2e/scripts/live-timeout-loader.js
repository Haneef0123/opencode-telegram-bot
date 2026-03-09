"use strict";

// Speeds up long bot timers for live E2E while preserving behavior.
const originalSetTimeout = global.setTimeout;
global.setTimeout = (fn, delay, ...args) => {
  let adjusted = delay;
  if (delay === 10 * 60 * 1000) adjusted = 2500; // interaction timeout
  if (delay === 3000) adjusted = 500; // SSE reconnect delay
  return originalSetTimeout(fn, adjusted, ...args);
};
