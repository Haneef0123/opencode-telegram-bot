"use strict";

const { createMockFetch } = require("./helpers/setup");

const ORIGINAL_ENV = { ...process.env };

function loadBotWithEnv(envOverrides = {}, clearKeys = []) {
  jest.resetModules();
  // Restore baseline environment for each load
  process.env = { ...ORIGINAL_ENV };
  for (const key of clearKeys) delete process.env[key];
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  }
  return require("../bot");
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ─── authHeader ───────────────────────────────────────────────────────────────

describe("authHeader", () => {
  test("returns empty object when no password set", () => {
    const botModule = loadBotWithEnv({
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
    });
    expect(botModule.authHeader()).toEqual({});
  });

  test("TYPING_INTERVAL_MS is 4000", () => {
    const botModule = loadBotWithEnv();
    expect(botModule.TYPING_INTERVAL_MS).toBe(4000);
  });

  test("INTERACTION_TIMEOUT_MS is 10 minutes", () => {
    const botModule = loadBotWithEnv();
    expect(botModule.INTERACTION_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test("SSE_RECONNECT_DELAY_MS is 3000", () => {
    const botModule = loadBotWithEnv();
    expect(botModule.SSE_RECONNECT_DELAY_MS).toBe(3000);
  });

  test("authHeader returns Basic auth when password is set", () => {
    const botModule = loadBotWithEnv({
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_SERVER_USERNAME: "",
    });
    const expected = Buffer.from("opencode:secret").toString("base64");
    expect(botModule.authHeader()).toEqual({ Authorization: `Basic ${expected}` });
  });

  test("OPENCODE_URL strips trailing slash", async () => {
    const botModule = loadBotWithEnv({
      OPENCODE_SERVER_URL: "http://localhost:4096/",
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
    });
    global.fetch = createMockFetch();
    await botModule.ocFetch("GET", "/session");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4096/session",
      expect.any(Object)
    );
  });

  test("OPENCODE_URL defaults to http://localhost:4096 when unset", async () => {
    const botModule = loadBotWithEnv(
      {
        OPENCODE_SERVER_URL: "",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
      },
      ["OPENCODE_SERVER_URL"]
    );
    global.fetch = createMockFetch();
    await botModule.ocFetch("GET", "/session");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4096/session",
      expect.any(Object)
    );
  });
});
