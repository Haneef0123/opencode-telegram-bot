"use strict";

const { splitMessage, escapeMarkdown, TELEGRAM_MAX } = require("../src/bot/messageFormatter");

describe("messageFormatter", () => {
  test("TELEGRAM_MAX uses Telegram message limit", () => {
    expect(TELEGRAM_MAX).toBe(4096);
  });

  test("splitMessage returns empty array for empty or whitespace-only input", () => {
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("   ")).toEqual([]);
    expect(splitMessage(null)).toEqual([]);
  });

  test("splitMessage returns one chunk when under max", () => {
    expect(splitMessage("hello", 10)).toEqual(["hello"]);
  });

  test("splitMessage prefers newline boundaries when available", () => {
    const text = "A".repeat(10) + "\n" + "B".repeat(10);
    const chunks = splitMessage(text, 15);
    expect(chunks).toEqual(["A".repeat(10), "B".repeat(10)]);
  });

  test("splitMessage hard-splits when no newline is available", () => {
    const chunks = splitMessage("X".repeat(11), 5);
    expect(chunks).toEqual(["XXXXX", "XXXXX", "X"]);
  });

  test("splitMessage removes a leading newline from remaining chunk after split", () => {
    const text = "Hello\nWorld";
    const chunks = splitMessage(text, 6);
    expect(chunks).toEqual(["Hello", "World"]);
  });

  test("escapeMarkdown escapes Telegram MarkdownV2 special characters", () => {
    const input = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeMarkdown(input);
    expect(escaped).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
  });
});
