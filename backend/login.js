/* One-time interactive Telegram login. Saves a session string to backend/.env. */
import readline from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { loadEnv, saveEnv } from "./common.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q + " ")).trim();

const validId = (v) => /^\d{5,12}$/.test(String(v)) && Number(v) > 0;
const validHash = (v) => /^[0-9a-fA-F]{32}$/.test(String(v));

async function main() {
  const env = loadEnv();

  console.log("ZipStream backend — Telegram login (user session / MTProto)\n");
  console.log("You need an api_id + api_hash (free, ~1 minute):");
  console.log("  1. Open https://my.telegram.org and log in with your phone number.");
  console.log("  2. Go to 'API development tools' and create an application.");
  console.log("  3. Copy the api_id (a NUMBER) and api_hash (a 32-char HEX string).\n");

  let apiId = env.TG_API_ID ? Number(env.TG_API_ID) : 0;
  let apiHash = env.TG_API_HASH || "";

  while (!validId(apiId)) {
    if (apiId) console.log("  ⚠️  That's not a valid api_id — it must be a plain number, e.g. 28946382.");
    apiId = Number(await ask("api_id:"));
  }
  while (!validHash(apiHash)) {
    if (apiHash) console.log("  ⚠️  That's not a valid api_hash — it must be exactly 32 characters (0-9 and a-f).");
    apiHash = await ask("api_hash:");
  }

  const stringSession = new StringSession(env.TG_SESSION || "");
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => ask("Phone number (international, e.g. +15551234567):"),
    password: async (hint) =>
      (await ask(hint ? `2FA password (hint: ${hint}):` : "2FA password (press Enter if none):")) || "",
    phoneCode: async () => ask("Login code (from Telegram app / SMS):"),
    onError: (err) => console.error("Auth error:", err.message),
  });

  saveEnv({ TG_API_ID: String(apiId), TG_API_HASH: apiHash, TG_SESSION: stringSession.save() });
  console.log("\n✅ Logged in. Session saved to backend/.env  (keep this file private — do not commit it).");
  console.log("Start the server with:  npm start");
  await client.disconnect();
  rl.close();
}

main().catch((e) => {
  console.error("Login failed:", e.message);
  rl.close();
  process.exit(1);
});
