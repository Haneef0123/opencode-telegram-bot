"use strict";

const TELEGRAM_MAX = 4096;

function splitMessage(text, max = TELEGRAM_MAX) {
  if (!text || !text.trim()) return [];

  const chunks = [];
  let remaining = text;

  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf("\n", max);
    if (splitAt <= 0) splitAt = max;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

module.exports = { splitMessage, escapeMarkdown, TELEGRAM_MAX };
