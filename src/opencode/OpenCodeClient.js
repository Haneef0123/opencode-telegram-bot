"use strict";

class OpenCodeClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }

  authHeader() {
    if (!this.password) return {};
    const creds = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return { Authorization: `Basic ${creds}` };
  }

  async fetch(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode ${res.status}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async createSession(chatId) {
    const session = await this.fetch("POST", "/session", {
      title: `Telegram Chat ${chatId}`,
    });
    return session.id;
  }

  async sendPromptAsync(sessionId, text) {
    await this.fetch("POST", `/session/${sessionId}/prompt_async`, {
      parts: [{ type: "text", text }],
    });
  }

  async replyPermission(requestId, reply) {
    return this.fetch("POST", `/permission/${requestId}/reply`, { reply });
  }

  async replyQuestion(requestId, answers) {
    return this.fetch("POST", `/question/${requestId}/reply`, { answers });
  }

  async rejectQuestion(requestId) {
    await this.fetch("POST", `/question/${requestId}/reject`, {});
  }

  async fetchLastAssistantText(sessionId) {
    const messages = await this.fetch("GET", `/session/${sessionId}/message`);
    const assistants = messages.filter((m) => m.info.role === "assistant");
    if (!assistants.length) return null;
    const last = assistants[assistants.length - 1];
    const text = last.parts
      .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text)
      .join("")
      .trim();
    return text || null;
  }

  async abortSession(sessionId) {
    await this.fetch("POST", `/session/${sessionId}/abort`, {});
  }

  async listSessions() {
    return this.fetch("GET", "/session");
  }
}

module.exports = OpenCodeClient;
