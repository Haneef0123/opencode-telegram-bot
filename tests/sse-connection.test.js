"use strict";

const SSEConnection = require("../src/opencode/SSEConnection");

function createSseResponse({ ok = true, status = 200, text = "", chunks = [] } = {}) {
  let index = 0;
  return {
    ok,
    status,
    text: async () => text,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { value: undefined, done: true };
          const value = Buffer.from(chunks[index], "utf8");
          index += 1;
          return { value, done: false };
        },
      }),
    },
  };
}

describe("SSEConnection", () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("dispatch routes to registered handler with properties", async () => {
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      fetchImpl: jest.fn(),
    });
    const handler = jest.fn();
    conn.on("session.idle", handler);

    conn.dispatch({
      payload: {
        type: "session.idle",
        properties: { sessionID: "s1" },
      },
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({ sessionID: "s1" });
  });

  test("dispatch catches async handler failures and logs them", async () => {
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      fetchImpl: jest.fn(),
    });
    conn.on("session.error", async () => {
      throw new Error("boom");
    });

    conn.dispatch({
      payload: { type: "session.error", properties: {} },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith("[dispatch session.error]", "boom");
  });

  test("connect opens SSE stream, dispatches events, and schedules reconnect on stream end", async () => {
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const event = {
      payload: {
        type: "session.idle",
        properties: { sessionID: "sess-1" },
      },
    };
    const fetchImpl = jest.fn().mockResolvedValue(
      createSseResponse({
        chunks: [`data: ${JSON.stringify(event)}\n`],
      })
    );
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({ Authorization: "Basic abc" }),
      reconnectDelayMs: 1234,
      fetchImpl,
    });
    const handler = jest.fn();
    conn.on("session.idle", handler);

    await conn.connect();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4096/global/event",
      expect.objectContaining({
        headers: { Accept: "text/event-stream", Authorization: "Basic abc" },
        signal: expect.any(AbortSignal),
      })
    );
    expect(handler).toHaveBeenCalledWith({ sessionID: "sess-1" });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
    conn.disconnect();
  });

  test("connect logs parse errors for invalid JSON payload lines", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      createSseResponse({
        chunks: ["data: {not-json}\n"],
      })
    );
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      reconnectDelayMs: 10,
      fetchImpl,
    });

    await conn.connect();

    expect(errorSpy).toHaveBeenCalledWith(
      "[SSE] JSON parse error:",
      expect.any(String),
      "raw:",
      "{not-json}"
    );
    conn.disconnect();
  });

  test("connect schedules reconnect when HTTP response is non-ok", async () => {
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const fetchImpl = jest.fn().mockResolvedValue(
      createSseResponse({ ok: false, status: 503, text: "down" })
    );
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      reconnectDelayMs: 321,
      fetchImpl,
    });

    await conn.connect();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 321);
    conn.disconnect();
  });

  test("connect does not reconnect on AbortError", async () => {
    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fetchImpl = jest.fn().mockRejectedValue(abortError);
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      fetchImpl,
    });

    await conn.connect();

    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  test("disconnect aborts active controller and clears reconnect timer", () => {
    const clearSpy = jest.spyOn(global, "clearTimeout");
    const conn = new SSEConnection({
      baseUrl: "http://localhost:4096",
      authHeader: () => ({}),
      fetchImpl: jest.fn(),
    });
    conn.abortController = new AbortController();
    const abortSpy = jest.spyOn(conn.abortController, "abort");
    conn.reconnectTimer = setTimeout(() => {}, 1000);

    conn.disconnect();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(conn.abortController).toBeNull();
    expect(conn.reconnectTimer).toBeNull();
  });
});
