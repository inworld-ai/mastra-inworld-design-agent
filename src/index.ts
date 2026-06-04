import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { adminProxy, handleAdminUpgrade, startStudio } from "./admin";
import { createDesigner, type DesignerAgent } from "./mastra/agents/designer";
import { resolveDesignerInstructions } from "./mastra/resolve-instructions";
import { createSiteState, defaults, type SiteStateStore } from "./mastra/state/site-state";

const PORT = Number(process.env.PORT ?? 4111);

// Demo-stability net: a stray async error (e.g. a terminated proxied stream)
// shouldn't take down every active voice session. Log and keep serving.
process.on("uncaughtException", (err) => console.error("[uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[unhandled rejection]", err));

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

/* ---------- /api/state ----------
 *
 * Returns the public landing-page defaults. There's no shared "current
 * state" — every visitor sees this until they open a voice session, and
 * any changes they make live only inside their own WebSocket session.
 */

app.get("/api/state", (c) => c.json(defaults));

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
  siteState: SiteStateStore;
  /** Current upstream voice connection; null briefly while recovering. */
  voice: InworldVoice | null;
  /** response_ids that have been cancelled — drop further `speaking` chunks. */
  cancelled: Set<string>;
  /** Armed when a response is owed (user turn ended / tool output sent). */
  watchdog: NodeJS.Timeout | null;
  recovering: boolean;
  recoveries: number;
  closed: boolean;
  cleanup: () => Promise<void>;
};

const sessions = new WeakMap<WSContext, VoiceSession>();

/** No assistant activity within this window after a turn ends → wedged. */
const RESPONSE_WATCHDOG_MS = 15_000;
const MAX_RECOVERIES = 3;

function sendJSON(ws: WSContext, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-send */
  }
}

function disarmWatchdog(session: VoiceSession): void {
  if (session.watchdog) clearTimeout(session.watchdog);
  session.watchdog = null;
}

function armWatchdog(session: VoiceSession, ws: WSContext): void {
  disarmWatchdog(session);
  session.watchdog = setTimeout(() => {
    void recoverSession(session, ws, "no response within watchdog window");
  }, RESPONSE_WATCHDOG_MS);
}

function closeVoice(session: VoiceSession): void {
  disarmWatchdog(session);
  const voice = session.voice;
  session.voice = null;
  try {
    voice?.close();
  } catch {
    /* already closed */
  }
}

/* ---------- Recovery ----------
 *
 * The realtime session can die in ways the SDK doesn't surface (silent
 * upstream socket drops) or wedge while the socket stays open (no response
 * ever arrives). Either way: tear down just the voice connection and build a
 * fresh one UNDER the same browser session — same WS, same site state, so
 * the visitor keeps their design. The recovered agent announces the hiccup.
 */
async function recoverSession(session: VoiceSession, ws: WSContext, reason: string): Promise<void> {
  if (session.closed || session.recovering) return;
  session.recovering = true;
  session.recoveries += 1;
  console.warn(`voice session recovery #${session.recoveries}: ${reason}`);

  closeVoice(session);

  if (session.recoveries > MAX_RECOVERIES) {
    sendJSON(ws, { type: "error", message: "voice session lost — tap to restart" });
    ws.close(1011, "voice unrecoverable");
    session.recovering = false;
    return;
  }

  sendJSON(ws, { type: "error", message: "voice hiccup — reconnecting…" });
  try {
    await connectVoice(session, ws, {
      seed: "[The voice connection dropped and recovered. Briefly acknowledge the hiccup and ask the user to repeat their last request.]",
    });
  } catch (err) {
    console.warn("recovery failed:", err instanceof Error ? err.message : err);
    sendJSON(ws, { type: "error", message: "voice session lost — tap to restart" });
    ws.close(1011, "voice unrecoverable");
  } finally {
    session.recovering = false;
  }
}

/** Build a designer + voice over the session's existing state, wire events,
 *  connect, and kick off a spoken intro. Used for both first connect and
 *  recovery. */
async function connectVoice(
  session: VoiceSession,
  ws: WSContext,
  intro: { seed: string },
): Promise<void> {
  // Latest published Studio edit, if any — resolved per (re)connect so saves
  // in /admin apply without a restart.
  const instructionsOverride = await resolveDesignerInstructions();
  const agent = createDesigner(session.siteState, instructionsOverride);
  const voice = await agent.getVoice();
  if (!voice) throw new Error("voice provider unavailable");

  const cancelled = session.cancelled;

  /* Watchdog wiring — at the RAW protocol layer, not the SDK's curated
   * events. The SDK emits nothing when a tool call's argument JSON fails to
   * parse (its catch path silently sends the error + response.create), which
   * is exactly the path that precedes observed wedges. So instead:
   *   - a response is OWED when we send response.create, the server opens
   *     one (response.created), or the user's turn commits
   *   - while owed, ANY wire event is a heartbeat (deltas reset the timer)
   *   - response.done settles the debt (a tool follow-up re-arms via its
   *     own response.create); the user starting to speak cancels it
   */
  const raw = voice as unknown as {
    client?: { emit: (...args: unknown[]) => boolean };
    sendEvent?: (type: string, data: unknown) => void;
  };
  // `session.voice === voice` guards: after a recovery swaps the connection,
  // a stale instance must not arm the new session's watchdog.
  if (raw.client) {
    const origEmit = raw.client.emit.bind(raw.client);
    raw.client.emit = (...args: unknown[]) => {
      if (session.voice === voice) {
        const type = args[0] as string;
        if (type === "response.created" || type === "input_audio_buffer.committed") {
          armWatchdog(session, ws);
        } else if (type === "response.done" || type === "input_audio_buffer.speech_started") {
          disarmWatchdog(session);
        } else if (session.watchdog) {
          armWatchdog(session, ws); // heartbeat — activity while owed resets the clock
        }
      }
      return origEmit(...args);
    };
  }
  if (raw.sendEvent) {
    const origSend = raw.sendEvent.bind(voice);
    raw.sendEvent = (type: string, data: unknown) => {
      if (type === "response.create" && session.voice === voice) armWatchdog(session, ws);
      origSend(type, data);
    };
  }

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

  // The first spoken response on a connection is its intro (greeting or
  // recovery apology) — completing THAT must not forgive recoveries, or an
  // error→recover→apology→error cycle would loop forever under the cap.
  let introDone = false;

  on("speaking.done", (payload: unknown) => {
    const { response_id } = payload as { response_id?: string };
    if (response_id) cancelled.delete(response_id);
    if (introDone) {
      // A real answer completed = the session is healthy; forgive past
      // hiccups so sporadic recoveries over a long session don't exhaust
      // the cap.
      session.recoveries = 0;
    }
    introDone = true;
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
    sendJSON(ws, { type: "state", state: session.siteState.get() });
  });

  on("interrupted", (payload: unknown) => {
    const { response_id } = payload as { response_id?: string };
    if (response_id) cancelled.add(response_id);
    // `interrupt_response: true` already cancels the response server-side from
    // VAD; the `cancelled` set above drops any tail chunks still in flight.
    sendJSON(ws, { type: "interrupted", responseId: response_id });
  });

  on("response.done", () => {
    sendJSON(ws, { type: "state", state: session.siteState.get() });
  });

  on("error", (err: unknown) => {
    // Inworld error events nest the useful part: { error: { message, ... } }.
    const e = err as { message?: string; error?: { message?: string } };
    const message =
      e?.error?.message ?? e?.message ?? (err instanceof Error ? err.message : JSON.stringify(err));
    console.warn(
      "upstream voice error:",
      typeof err === "object" ? JSON.stringify(err).slice(0, 600) : String(err),
    );
    sendJSON(ws, { type: "error", message });
    // A server-side error mid-session leaves the conversation wedged: the
    // error's own response.done settles the watchdog, and every following
    // turn errors again. A fresh session is the only way back — rebuild.
    if (session.voice === voice) {
      void recoverSession(session, ws, `upstream error event: ${message}`);
    }
  });

  await voice.connect();
  session.voice = voice;

  // The SDK only watches its upstream socket during the connect handshake —
  // if Inworld drops the connection mid-session, no event fires and the
  // session silently stops responding. Watch the raw socket ourselves.
  const upstream = (
    voice as unknown as { ws?: { once: (ev: string, cb: (...a: never[]) => void) => void } }
  ).ws;
  upstream?.once("close", ((code: number, reason: Buffer) => {
    // Stale or self-initiated closes (recovery/cleanup) are expected.
    if (session.closed || session.voice !== voice) return;
    void recoverSession(
      session,
      ws,
      `upstream closed: ${code} ${reason?.toString() || "(no reason)"}`,
    );
  }) as never);

  // Spoken intro (greeting or recovery notice). NOT voice.speak(): per
  // realtime-API semantics, speak()'s response.create carries per-response
  // instructions ("Repeat the following text: …") that REPLACE the session
  // instructions for that response — the model would repeat the text, lose
  // every voice rule, and then improvise a markdown feature menu. It also
  // plants the text in history as a user message. Instead: seed one user item
  // (Anthropic rejects a response on an empty conversation) and trigger a
  // bare answer() so the session instructions govern the intro.
  (voice as unknown as { sendEvent: (type: string, data: unknown) => void }).sendEvent(
    "conversation.item.create",
    {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: intro.seed }],
      },
    },
  );
  void voice.answer({}).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    sendJSON(ws, { type: "error", message: `intro: ${message}` });
  });
}

async function attachAgent(ws: WSContext): Promise<VoiceSession | null> {
  if (!process.env.INWORLD_API_KEY) {
    sendJSON(ws, { type: "error", message: "INWORLD_API_KEY is not set" });
    ws.close(1011, "missing api key");
    return null;
  }

  const session: VoiceSession = {
    siteState: createSiteState(),
    voice: null,
    cancelled: new Set<string>(),
    watchdog: null,
    recovering: false,
    recoveries: 0,
    closed: false,
    cleanup: async () => {
      session.closed = true;
      closeVoice(session);
    },
  };

  try {
    await connectVoice(session, ws, {
      seed: "[A visitor just joined the session — greet them.]",
    });
  } catch (err) {
    sendJSON(ws, {
      type: "error",
      message: `connect failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    ws.close(1011, "connect failed");
    return null;
  }

  sendJSON(ws, { type: "state", state: session.siteState.get() });
  sendJSON(ws, { type: "ready" });
  return session;
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
      if (!session || !session.voice) return; // voice is null mid-recovery

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
        // TEST_HOOKS=1 only: exercise the two real failure modes.
        // __kill_upstream severs the socket like an Inworld-side drop;
        // __wedge_upstream goes deaf (socket open, no events) with a
        // response owed — the silent-wedge case the watchdog exists for.
        if (process.env.TEST_HOOKS === "1" && msg?.type === "__kill_upstream") {
          (session.voice as unknown as { ws?: { terminate?: () => void } })?.ws?.terminate?.();
          return;
        }
        if (process.env.TEST_HOOKS === "1" && msg?.type === "__wedge_upstream") {
          const v = session.voice as unknown as {
            ws?: { removeAllListeners?: (ev: string) => void };
            sendEvent?: (t: string, d: unknown) => void;
          };
          v?.ws?.removeAllListeners?.("message");
          v?.sendEvent?.("response.create", {});
          return;
        }
        // __error_upstream: replay a server-side error event (the
        // poisoned-conversation mode where every turn errors).
        if (process.env.TEST_HOOKS === "1" && msg?.type === "__error_upstream") {
          (session.voice as unknown as { emit?: (ev: string, p: unknown) => void })?.emit?.(
            "error",
            { error: { message: "simulated upstream error" } },
          );
          return;
        }
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
 * Serve everything under ./public for non-API GETs. dev, start, and the
 * Render deploy all run from the project root, so cwd is enough. */

const publicDir = path.resolve(process.cwd(), "public");

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

const server = serve(
  { fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? "0.0.0.0" },
  (info) => {
    console.log(`design-agent server on http://localhost:${info.port}`);
    console.log(`voice WS at ws://localhost:${info.port}/api/voice`);
  },
);

injectWebSocket(server);

// @hono/node-ws's upgrade listener force-closes any upgrade it doesn't own,
// so re-dispatch: /admin upgrades (Studio's playground WS) go to the proxy,
// everything else falls through to node-ws for /api/voice.
{
  const nodeWsListeners = server.listeners("upgrade").slice() as Array<
    (req: never, socket: never, head: never) => void
  >;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket, head) => {
    if (handleAdminUpgrade(req, socket, head)) return;
    for (const listener of nodeWsListeners) {
      listener(req as never, socket as never, head as never);
    }
  });
}

startStudio(path.dirname(publicDir));
