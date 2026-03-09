"use strict";

const { createMockFetch, createMockBot, resetBotState } = require("./helpers/setup");

process.env.TELEGRAM_BOT_TOKEN = "test-token";
const botModule = require("../bot");

let mockBot;

beforeEach(() => {
  jest.useFakeTimers();
  resetBotState(botModule);
  mockBot = createMockBot();
  botModule.setBotInstance(mockBot);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("handlePermissionAsked", () => {
  test("sends inline keyboard with 3 buttons (Allow Once, Always Allow, Deny)", async () => {
    global.fetch = createMockFetch();
    const req = { id: "perm-1", permission: "file.write", metadata: {} };

    await botModule.handlePermissionAsked(700, req);

    const [chatId, text, opts] = mockBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(700);
    expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(3);
  });

  test("message includes permission type", async () => {
    global.fetch = createMockFetch();
    const req = { id: "perm-2", permission: "shell.execute", metadata: {} };

    await botModule.handlePermissionAsked(701, req);

    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("`shell.execute`");
  });

  test("message includes command metadata when present", async () => {
    global.fetch = createMockFetch();
    const req = { id: "perm-3", permission: "shell.execute", metadata: { command: "rm -rf /tmp" } };

    await botModule.handlePermissionAsked(702, req);

    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("rm -rf /tmp");
  });

  test("message includes path metadata when present", async () => {
    global.fetch = createMockFetch();
    const req = { id: "perm-4", permission: "file.read", metadata: { path: "/etc/passwd" } };

    await botModule.handlePermissionAsked(703, req);

    const [, text] = mockBot.sendMessage.mock.calls[0];
    expect(text).toContain("/etc/passwd");
  });

  test("stores pendingPermission with requestId, messageId, timer", async () => {
    global.fetch = createMockFetch();
    const req = { id: "perm-5", permission: "file.write", metadata: {} };

    await botModule.handlePermissionAsked(704, req);

    const state = botModule.getState(704);
    expect(state.pendingPermission).not.toBeNull();
    expect(state.pendingPermission.requestId).toBe("perm-5");
    expect(state.pendingPermission.messageId).toBe(1); // mocked message_id
    expect(state.pendingPermission.timer).toBeDefined();
  });

  test("clears previous pending permission when new one arrives", async () => {
    global.fetch = createMockFetch();
    const state = botModule.getState(705);
    const oldTimer = setTimeout(() => {}, 999999);
    state.pendingPermission = { requestId: "old", messageId: 99, timer: oldTimer };

    const req = { id: "new-perm", permission: "file.write", metadata: {} };
    await botModule.handlePermissionAsked(705, req);

    expect(state.pendingPermission.requestId).toBe("new-perm");
  });

  test("stops typing then restarts typing after showing permission", async () => {
    global.fetch = createMockFetch();
    const state = botModule.getState(706);
    state.typingTimer = setTimeout(() => {}, 999999);

    const req = { id: "perm-flow", permission: "file.write", metadata: {} };
    await botModule.handlePermissionAsked(706, req);

    // After handlePermissionAsked, startTyping is called again
    expect(mockBot.sendChatAction).toHaveBeenCalledWith(706, "typing");
  });

  test("timeout auto-denies after INTERACTION_TIMEOUT_MS", async () => {
    global.fetch = createMockFetch({
      "/permission/perm-timeout/reply": { body: "" },
    });
    const req = { id: "perm-timeout", permission: "shell.execute", metadata: {} };

    await botModule.handlePermissionAsked(707, req);
    expect(botModule.getState(707).pendingPermission).not.toBeNull();

    jest.advanceTimersByTime(botModule.INTERACTION_TIMEOUT_MS);
    await jest.runOnlyPendingTimersAsync();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/permission/perm-timeout/reply"),
      expect.any(Object)
    );
    expect(botModule.getState(707).pendingPermission).toBeNull();
  });
});
