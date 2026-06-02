import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adminProxy, handleAdminUpgrade, startStudio } from "./admin";
import { createDesigner, type DesignerAgent } from "./mastra/agents/designer";
import { createSiteState, defaults, type SiteStateStore } from "./mastra/state/site-state";

const PORT = Number(process.env.PORT ?? 4111);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

/* ---------- /api/state ----------
 *
 * Returns the public landing-page defaults. There's no shared "current
 * state" — every visitor sees this until they open a voice session, and
 * any changes they make live only inside their own WebSocket session.
 */

app.get("/api/state", c => c.json(defaults));

/* ---------- /api/voice (WebSocket) ----------
 *
 * Per-connection isolation: each WS gets its own site-state store, its own
 * agent, and its own Inworld realtime voice. User A's "make it dark" does
 * NOT touch user B's page — the store is closed over by this session's
 * tools and never escapes.
 *
 * Wire protocol:
 *   - Server → client BINARY: PCM16 mono @ 24kHz audio chunks.
 *   - Server → client TEXT (JSON): { type, ... } control messages
 *       { type:"ready" }                                  on connect
 *       { type:"transcript", role, text, responseId }     streamed text
 *       { type:"state", state }                           full site state snapshot
 *       { type:"tool", toolName, args, result }           tool call summary
 *       { type:"interrupted", responseId }                barge-in (drain audio)
 *       { type:"speaking.done", responseId }              end of one TTS response
 *       { type:"error", message }
 *   - Client → server BINARY: PCM16 mono @ 24kHz mic chunks.
 *   - Client → server TEXT (JSON):
 *       { type:"hello" }   currently a no-op — connection is the contract
 */

type InworldVoice = NonNullable<Awaited<ReturnType<DesignerAgent["getVoice"]>>>;

type VoiceSession = {
  agent: DesignerAgent;
  voice: InworldVoice;
  siteState: SiteStateStore;
  /** response_ids that have been cancelled — drop further `speaking` chunks. */
  cancelled: Set<string>;
  cleanup: () => Promise<void>;
};

const sessions = new WeakMap<WSContext, VoiceSession>();

function sendJSON(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-send */
  }
}

async function attachAgent(ws: WSContext): Promise<VoiceSession | null> {
  if (!process.env.INWORLD_API_KEY) {
    sendJSON(ws, { type: "error", message: "INWORLD_API_KEY is not set" });
    ws.close(1011, "missing api key");
    return null;
  }

  const siteState = createSiteState();
  const agent = createDesigner(siteState);
  const voice = await agent.getVoice();
  if (!voice) {
    sendJSON(ws, { type: "error", message: "voice provider unavailable" });
    ws.close(1011, "no voice");
    return null;
  }

  const cancelled = new Set<string>();

  // Wire voice events → WS. Listeners type-check loosely because
  // MastraVoice's VoiceEventMap declares some fields narrower than the
  // Inworld runtime payloads (audio:Buffer vs string).
  const on = voice.on.bind(voice) as (event: string, cb: (...args: unknown[]) => void) => void;

  on("speaking", (payload: unknown) => {
    const { audio, response_id } = payload as { audio: Buffer | Uint8Array; response_id?: string };
    // Skip chunks for responses we already cancelled. Inworld typically stops
    // emitting them on its own once `interrupt_response` fires, but the server
    // can have a tail in flight, and dropping them here means the client never
    // even sees them.
    if (response_id && cancelled.has(response_id)) return;
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    if (response_id) sendJSON(ws, { type: "audio.header", responseId: response_id });
    try {
      // Buffer IS a Uint8Array at runtime; the cast only papers over
      // Node's ArrayBufferLike generic vs hono's ArrayBuffer constraint.
      ws.send(bytes as unknown as Uint8Array<ArrayBuffer>);
    } catch {
      /* socket closed */
    }
  });

  on("speaking.done", (payload: unknown) => {
    const { response_id } = payload as { response_id?: string };
    if (response_id) cancelled.delete(response_id);
    sendJSON(ws, { type: "speaking.done", responseId: response_id });
  });

  on("writing", (payload: unknown) => {
    const { text, role, response_id } = payload as {
      text: string;
      role: "user" | "assistant";
      response_id?: string;
    };
    sendJSON(ws, { type: "transcript", role, text, responseId: response_id });
  });

  on("tool-call-result", (payload: unknown) => {
    const { toolName, args, result } = payload as {
      toolName?: string;
      args?: unknown;
      result?: unknown;
    };
    sendJSON(ws, { type: "tool", toolName, args, result });
    sendJSON(ws, { type: "state", state: siteState.get() });
  });

  on("interrupted", (payload: unknown) => {
    const { response_id } = payload as { response_id?: string };
    if (response_id) cancelled.add(response_id);
    // `interrupt_response: true` already cancels the response server-side from
    // VAD; the `cancelled` set above drops any tail chunks still in flight.
    sendJSON(ws, { type: "interrupted", responseId: response_id });
  });

  on("response.done", () => {
    sendJSON(ws, { type: "state", state: siteState.get() });
  });

  on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    sendJSON(ws, { type: "error", message });
  });

  try {
    await voice.connect();
  } catch (err) {
    sendJSON(ws, {
      type: "error",
      message: `connect failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    ws.close(1011, "connect failed");
    return null;
  }

  // Send initial state + ready signal, then a fire-and-forget greeting. The
  // greeting's audio drains via the `speaking` listener; we don't await it
  // because we want `ready` (and any other queued frames) to flow ASAP.
  sendJSON(ws, { type: "state", state: siteState.get() });
  sendJSON(ws, { type: "ready" });
  void voice
    .speak("Hey there! I'm your design agent. What should we change first?")
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJSON(ws, { type: "error", message: `greeting: ${message}` });
    });

  const cleanup = async () => {
    try {
      voice.close();
    } catch {
      /* already closed */
    }
  };

  return { agent, voice, siteState, cancelled, cleanup };
}

app.get(
  "/api/voice",
  upgradeWebSocket(() => ({
    async onOpen(_evt: Event, ws: WSContext) {
      const session = await attachAgent(ws);
      if (session) sessions.set(ws, session);
    },

    async onMessage(evt: MessageEvent, ws: WSContext) {
      const session = sessions.get(ws);
      if (!session) return;

      const data = evt.data;
      // Binary mic frames. ws v8 hands us a Buffer for binary frames.
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        const byteLength = Buffer.isBuffer(data) ? data.byteLength : data.byteLength;
        if (byteLength === 0 || byteLength % 2 !== 0) return;
        const int16 = Buffer.isBuffer(data)
          ? new Int16Array(data.buffer, data.byteOffset, byteLength / 2)
          : new Int16Array(data);
        try {
          await session.voice.send(int16);
        } catch (err) {
          sendJSON(ws, {
            type: "error",
            message: `send failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      // Text frame — currently only "hello" is meaningful, but tolerate
      // unknown JSON so future control messages don't break older clients.
      try {
        const msg = JSON.parse(typeof data === "string" ? data : data.toString());
        if (msg && typeof msg === "object" && msg.type === "hello") return;
      } catch {
        /* ignore non-JSON text */
      }
    },

    async onClose(_evt: CloseEvent, ws: WSContext) {
      const session = sessions.get(ws);
      sessions.delete(ws);
      if (session) await session.cleanup();
    },

    async onError(_evt: Event, ws: WSContext) {
      const session = sessions.get(ws);
      sessions.delete(ws);
      if (session) await session.cleanup();
    },
  })),
);

/* ---------- /admin (Mastra Studio, basic-auth gated) ---------- */

app.all("/admin", adminProxy);
app.all("/admin/*", adminProxy);

/* ---------- Static files ----------
 *
 * Serve everything under ./public for non-API GETs. Walks up from this file
 * AND from cwd because `tsx watch` from project root works, but a bundled
 * deploy may run from a different directory. */

async function resolvePublicDir(): Promise<string> {
  if (process.env.MASTRA_PUBLIC_DIR) return path.resolve(process.env.MASTRA_PUBLIC_DIR);

  const seeds: string[] = [];
  try {
    seeds.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* not file://, skip */
  }
  seeds.push(process.cwd());

  for (const seed of seeds) {
    let dir = seed;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "public");
      try {
        const info = await stat(candidate);
        if (info.isDirectory()) return candidate;
      } catch {
        /* keep walking */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(process.cwd(), "public");
}

const publicDir = await resolvePublicDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

app.get("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) return next();

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, "." + pathname);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    return next();
  }

  try {
    const body = await readFile(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, { headers: { "content-type": mime } });
  } catch {
    return next();
  }
});

/* ---------- Boot ---------- */

const server = serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? "0.0.0.0" }, info => {
  console.log(`design-agent server on http://localhost:${info.port}`);
  console.log(`voice WS at ws://localhost:${info.port}/api/voice`);
});

injectWebSocket(server);

// @hono/node-ws's upgrade listener force-closes any upgrade it doesn't own,
// so re-dispatch: /admin upgrades (Studio's playground WS) go to the proxy,
// everything else falls through to node-ws for /api/voice.
{
  const nodeWsListeners = server
    .listeners("upgrade")
    .slice() as Array<(req: never, socket: never, head: never) => void>;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket, head) => {
    if (handleAdminUpgrade(req, socket, head)) return;
    for (const listener of nodeWsListeners) {
      listener(req as never, socket as never, head as never);
    }
  });
}

startStudio(path.dirname(publicDir));
