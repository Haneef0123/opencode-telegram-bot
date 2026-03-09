"use strict";

require("dotenv").config();

const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    const envApiId = process.env.TG_API_ID ? Number(process.env.TG_API_ID) : null;
    const envApiHash = process.env.TG_API_HASH || null;
    const envPhone = process.env.TG_PHONE || null;

    const apiId = envApiId || Number(await rl.question("TG_API_ID: "));
    const apiHash = envApiHash || (await rl.question("TG_API_HASH: "));
    const phone = envPhone || (await rl.question("TG_PHONE (e.g. +91...): "));

    if (!apiId || !apiHash || !phone) {
      throw new Error("Missing TG_API_ID/TG_API_HASH/TG_PHONE");
    }

    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => rl.question("OTP code from Telegram: "),
      password: async () => rl.question("2FA password (if enabled): "),
      onError: (err) => console.error("Auth error:", err?.message || err),
    });

    const stringSession = client.session.save();
    console.log(`\nTG_STRING_SESSION=${stringSession}`);

    await client.disconnect();
  } finally {
    await rl.close();
  }
}

main().catch((err) => {
  console.error("Failed to generate TG_STRING_SESSION:", err.message || err);
  process.exit(1);
});
