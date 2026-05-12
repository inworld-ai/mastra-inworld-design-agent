#!/usr/bin/env node
// Second smoke test: force a text+audio response (no tools) so we observe
// response.text.delta / response.audio.delta / response.audio_transcript.delta
// event shapes that the first smoke test didn't trigger.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.resolve(__dirname, "..", ".env"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const startedAt = Date.now();
const eventLog = [];
const log = (...a) =>
  console.log(`[${String(Date.now() - startedAt).padStart(5, " ")}ms]`, ...a);

const ws = new WebSocket("wss://api.inworld.ai/api/v1/realtime/session", {
  headers: { Authorization: `Basic ${env.INWORLD_API_KEY}` },
});

ws.on("open", () => {
  log("ws open");
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        model: "anthropic/claude-sonnet-4-6",
        instructions: "Reply with one short sentence. No tools.",
        output_modalities: ["text", "audio"],
        audio: { output: { format: "audio/pcm", voice: "Dennis" } },
      },
    }),
  );
});

let sent = false;
ws.on("message", (raw) => {
  const t = Date.now() - startedAt;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const sample = { ...msg };
  for (const k of ["delta", "audio", "transcript"]) {
    if (typeof sample[k] === "string" && sample[k].length > 80) {
      sample[k] = `<${sample[k].length} chars>`;
    }
  }
  eventLog.push({ t, type: msg.type });
  log(`← ${msg.type}`, JSON.stringify(sample).slice(0, 220));

  if (msg.type === "session.updated" && !sent) {
    sent = true;
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello in three words." }],
        },
      }),
    );
    setTimeout(() => ws.send(JSON.stringify({ type: "response.create" })), 150);
  }
  if (msg.type === "response.done") setTimeout(() => ws.close(), 300);
});

ws.on("close", () => {
  const types = new Map();
  for (const e of eventLog) types.set(e.type, (types.get(e.type) ?? 0) + 1);
  console.log("\n=== EVENT TYPES ===");
  for (const [t, c] of [...types.entries()].sort()) console.log(`  ${t.padEnd(48)} ${c}`);
  process.exit(0);
});

ws.on("error", (e) => { log("error:", e.message); process.exit(1); });
setTimeout(() => { log("timeout"); ws.close(); }, 30_000);
