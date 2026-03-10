"use strict";

const OpenCodeClient = require("../src/opencode/OpenCodeClient");

function mockResponse({ ok = true, status = 200, body = "{}" } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("OpenCodeClient class", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("authHeader returns empty object when password is missing", () => {
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
    });
    expect(client.authHeader()).toEqual({});
  });

  test("authHeader returns Basic auth header when password is set", () => {
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "opencode",
      password: "secret",
    });
    const expected = Buffer.from("opencode:secret").toString("base64");
    expect(client.authHeader()).toEqual({ Authorization: `Basic ${expected}` });
  });

  test("fetch parses JSON body on success", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ body: { ok: true } })
    );
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await expect(client.fetch("GET", "/session")).resolves.toEqual({ ok: true });
  });

  test("fetch returns raw text when response is not JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ body: "not-json" })
    );
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await expect(client.fetch("GET", "/session")).resolves.toBe("not-json");
  });

  test("fetch throws on non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 500, body: "boom" })
    );
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await expect(client.fetch("GET", "/session")).rejects.toThrow("OpenCode 500: boom");
  });

  test("rejectQuestion posts to reject endpoint", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ body: "" }));
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await client.rejectQuestion("q-123");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4096/question/q-123/reject",
      expect.objectContaining({ method: "POST" })
    );
  });

  test("abortSession posts to abort endpoint", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ body: "" }));
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await client.abortSession("sess-1");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4096/session/sess-1/abort",
      expect.objectContaining({ method: "POST" })
    );
  });

  test("listSessions gets /session list", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({ body: [{ id: "a" }, { id: "b" }] })
    );
    const client = new OpenCodeClient({
      baseUrl: "http://localhost:4096",
      username: "u",
      password: "",
    });

    await expect(client.listSessions()).resolves.toEqual([{ id: "a" }, { id: "b" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4096/session",
      expect.objectContaining({ method: "GET" })
    );
  });
});
