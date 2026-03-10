"use strict";

class SSEConnection {
  constructor({ baseUrl, authHeader, reconnectDelayMs = 3000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.authHeader = authHeader;
    this.reconnectDelayMs = reconnectDelayMs;
    this.fetchImpl = fetchImpl;
    this.handlers = new Map();
    this.abortController = null;
    this.reconnectTimer = null;
  }

  on(eventType, handler) {
    this.handlers.set(eventType, handler);
  }

  dispatch(event) {
    const type = event && event.payload ? event.payload.type : undefined;
    const props = (event && event.payload && event.payload.properties) || {};
    const handler = this.handlers.get(type);
    if (!handler) return;
    Promise.resolve(handler(props)).catch((err) => {
      console.error(`[dispatch ${type}]`, err.message);
    });
  }

  disconnect() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async connect() {
    this.disconnect();
    this.abortController = new AbortController();

    console.log("[SSE] Connecting to OpenCode event stream...");

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/global/event`, {
        headers: { Accept: "text/event-stream", ...this.authHeader() },
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connect failed: ${res.status} ${await res.text()}`);
      }

      console.log("[SSE] Connected.");

      let buffer = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw);
            this.dispatch(event);
          } catch (e) {
            console.error("[SSE] JSON parse error:", e.message, "raw:", raw.slice(0, 100));
          }
        }
      }

      console.log("[SSE] Stream ended. Reconnecting...");
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(`[SSE] Error: ${err.message}. Reconnecting in ${this.reconnectDelayMs}ms...`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error(`[SSE] reconnect failed: ${err.message}`);
      });
    }, this.reconnectDelayMs);
  }
}

module.exports = SSEConnection;
