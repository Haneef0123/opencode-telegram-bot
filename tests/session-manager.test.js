"use strict";

const SessionManager = require("../src/state/SessionManager");

describe("SessionManager", () => {
  let errorSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("getState creates default state and is referentially stable", () => {
    const manager = new SessionManager();
    const a = manager.getState(42);
    const b = manager.getState(42);

    expect(a).toEqual({
      sessionId: null,
      busy: false,
      pendingQueue: [],
      typingTimer: null,
      pendingPermission: null,
      questionState: null,
    });
    expect(a).toBe(b);
  });

  test("resetInteractions clears pending permission/question timers", () => {
    const manager = new SessionManager();
    const clearSpy = jest.spyOn(global, "clearTimeout");
    const state = manager.getState(1);
    state.pendingPermission = { timer: setTimeout(() => {}, 5000) };
    state.questionState = { timer: setTimeout(() => {}, 5000) };

    manager.resetInteractions(1);

    expect(state.pendingPermission).toBeNull();
    expect(state.questionState).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(2);
  });

  test("markBusy and markIdle toggle busy state", () => {
    const manager = new SessionManager();
    manager.markBusy(9);
    expect(manager.getState(9).busy).toBe(true);

    manager.markIdle(9);
    expect(manager.getState(9).busy).toBe(false);
  });

  test("ensureSession returns existing session without creating a new one", async () => {
    const manager = new SessionManager();
    const createSessionFn = jest.fn();
    manager.getState(11).sessionId = "sess-existing";

    const id = await manager.ensureSession(11, createSessionFn);

    expect(id).toBe("sess-existing");
    expect(createSessionFn).not.toHaveBeenCalled();
  });

  test("ensureSession creates and maps a new session", async () => {
    const manager = new SessionManager();
    const createSessionFn = jest.fn().mockResolvedValue("sess-new");

    const id = await manager.ensureSession(12, createSessionFn);

    expect(id).toBe("sess-new");
    expect(createSessionFn).toHaveBeenCalledWith(12);
    expect(manager.getState(12).sessionId).toBe("sess-new");
    expect(manager.sessionToChat.get("sess-new")).toBe(12);
  });

  test("rehydrateSessions maps sessions and keeps newest by updated time", async () => {
    const manager = new SessionManager();
    await manager.rehydrateSessions(async () => ([
      { id: "s-1-old", title: "Telegram Chat 77", time: { updated: 10 } },
      { id: "s-1-new", title: "Telegram Chat 77", time: { updated: 20 } },
      { id: "s-neg", title: "Telegram Chat -100", time: { updated: 5 } },
      { id: "ignored", title: "Other Session", time: { updated: 999 } },
    ]));

    expect(manager.getState(77).sessionId).toBe("s-1-new");
    expect(manager.sessionToChat.get("s-1-old")).toBe(77);
    expect(manager.sessionToChat.get("s-1-new")).toBe(77);
    expect(manager.sessionToChat.get("s-neg")).toBe(-100);
    expect(manager.sessionToChat.has("ignored")).toBe(false);
  });

  test("rehydrateSessions handles non-array responses safely", async () => {
    const manager = new SessionManager();
    await expect(manager.rehydrateSessions(async () => null)).resolves.toBeUndefined();
  });

  test("rehydrateSessions handles fetch failures without throwing", async () => {
    const manager = new SessionManager();
    await expect(
      manager.rehydrateSessions(async () => {
        throw new Error("Network down");
      })
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("[rehydrateSessions] Network down");
  });

  test("resetChat clears mapped session, queue, and interaction state", () => {
    const manager = new SessionManager();
    const state = manager.getState(21);
    state.sessionId = "s-21";
    state.busy = true;
    state.pendingQueue = ["a", "b"];
    state.pendingPermission = { timer: setTimeout(() => {}, 5000) };
    state.questionState = { timer: setTimeout(() => {}, 5000) };
    state.typingTimer = setTimeout(() => {}, 5000);
    manager.sessionToChat.set("s-21", 21);

    manager.resetChat(21);

    expect(manager.sessionToChat.has("s-21")).toBe(false);
    expect(state.sessionId).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.pendingQueue).toEqual([]);
    expect(state.pendingPermission).toBeNull();
    expect(state.questionState).toBeNull();
    expect(state.typingTimer).toBeNull();
  });

  test("queueMessage enforces maxQueueLength by dropping oldest first", () => {
    const manager = new SessionManager({ maxQueueLength: 2 });
    manager.queueMessage(31, "one");
    manager.queueMessage(31, "two");
    manager.queueMessage(31, "three");

    expect(manager.getState(31).pendingQueue).toEqual(["two", "three"]);
  });

  test("dequeueMessage returns FIFO values and null when queue is empty", () => {
    const manager = new SessionManager();
    manager.queueMessage(32, "first");
    manager.queueMessage(32, "second");

    expect(manager.dequeueMessage(32)).toBe("first");
    expect(manager.dequeueMessage(32)).toBe("second");
    expect(manager.dequeueMessage(32)).toBeNull();
  });
});
