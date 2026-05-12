#!/usr/bin/env node
// Raw WS smoke test against Inworld's Realtime API.
//
// Purpose: confirm the event names/shapes documented at
// https://docs.inworld.ai/api-reference/realtimeAPI/realtime/realtime-websocket
// match what the live server actually emits, so we can build
// @mastra/voice-inworld-realtime against verified types.
//
// Run: node scripts/inworld-realtime-smoke.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env");

// Minimal .env parser — avoids adding dotenv to the project.
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const API_KEY = env.INWORLD_API_KEY;
if (!API_KEY) {
  console.error("INWORLD_API_KEY missing from .env");
  process.exit(1);
}

const URL = "wss://api.inworld.ai/api/v1/realtime/session";
const eventLog = []; // { t: msSinceConnect, type, sample }
const startedAt = Date.now();

const log = (...args) =>
  console.log(`[${String(Date.now() - startedAt).padStart(5, " ")}ms]`, ...args);

const ws = new WebSocket(URL, {
  headers: { Authorization: `Basic ${API_KEY}` },
});

ws.on("open", () => {
  log("ws open");

  // Send session.update — Inworld docs say session.created is NOT emitted,
  // so session.updated is our handshake.
  const sessionUpdate = {
    type: "session.update",
    session: {
      model: "anthropic/claude-sonnet-4-6",
      instructions: "You are a terse assistant. Reply in one short sentence.",
      output_modalities: ["text", "audio"],
      audio: {
        input: { format: "audio/pcm" },
        output: { format: "audio/pcm", voice: "Dennis" },
      },
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Echo back a message",
          parameters: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      tool_choice: "auto",
    },
  };
  log("→ session.update");
  ws.send(JSON.stringify(sessionUpdate));
});

let userMessageSent = false;
let responseRequested = false;

ws.on("message", (raw) => {
  const t = Date.now() - startedAt;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    log("✗ non-JSON message:", raw.toString().slice(0, 200));
    return;
  }

  // Truncate big audio fields for readability.
  const sample = { ...msg };
  if (sample.delta && typeof sample.delta === "string" && sample.delta.length > 60) {
    sample.delta = `<${sample.delta.length} chars>`;
  }
  if (sample.audio && typeof sample.audio === "string" && sample.audio.length > 60) {
    sample.audio = `<${sample.audio.length} chars>`;
  }

  eventLog.push({ t, type: msg.type, sample });
  log(`← ${msg.type}`, JSON.stringify(sample).slice(0, 200));

  // After session.updated, send a text message and ask for a response.
  if (msg.type === "session.updated" && !userMessageSent) {
    userMessageSent = true;
    const item = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hi in three words." }],
      },
    };
    log("→ conversation.item.create");
    ws.send(JSON.stringify(item));

    setTimeout(() => {
      if (!responseRequested) {
        responseRequested = true;
        log("→ response.create");
        ws.send(JSON.stringify({ type: "response.create" }));
      }
    }, 200);
  }

  // Close shortly after response completes.
  if (msg.type === "response.done") {
    setTimeout(() => {
      log("response.done received — closing");
      ws.close();
    }, 500);
  }

  if (msg.type === "error") {
    log("✗ server error:", JSON.stringify(msg));
  }
});

ws.on("close", (code, reason) => {
  log(`ws close code=${code} reason=${reason?.toString() || "(none)"}`);
  printSummary();
  process.exit(0);
});

ws.on("error", (err) => {
  log("✗ ws error:", err.message);
  printSummary();
  process.exit(1);
});

// Hard timeout safety net.
setTimeout(() => {
  log("✗ 30s timeout — forcing close");
  ws.close();
}, 30_000);

function printSummary() {
  console.log("\n=== SUMMARY ===");
  console.log(`Total events: ${eventLog.length}`);
  const types = new Map();
  for (const e of eventLog) types.set(e.type, (types.get(e.type) ?? 0) + 1);
  console.log("\nEvent types observed (count):");
  for (const [type, count] of [...types.entries()].sort()) {
    console.log(`  ${type.padEnd(48)} ${count}`);
  }
  console.log("\nKey questions answered by this run:");
  console.log(`  - session.created emitted?       ${types.has("session.created") ? "YES" : "NO"}`);
  console.log(`  - response.started emitted?      ${types.has("response.started") ? "YES" : "NO"}`);
  console.log(`  - response.created emitted?      ${types.has("response.created") ? "YES (OpenAI-style)" : "NO"}`);
  console.log(`  - conversation.item.added?       ${types.has("conversation.item.added") ? "YES" : "NO"}`);
  console.log(`  - conversation.item.created?     ${types.has("conversation.item.created") ? "YES (OpenAI-style)" : "NO"}`);
  console.log(`  - function_calls_arguments.delta (plural)? ${types.has("response.function_calls_arguments.delta") ? "YES" : "NO"}`);
  console.log(`  - function_call_arguments.delta (singular)? ${types.has("response.function_call_arguments.delta") ? "YES" : "NO"}`);
}
