import type { Context, Next } from "hono";
import { streamSSE } from "hono/streaming";
import { designer } from "../mastra/agents/designer";
import { getState } from "../mastra/state/site-state";

type Middleware = {
  path: string;
  handler: (c: Context, next: Next) => Promise<Response | void>;
};

type SSEEvent = { event: string; data: string };

/**
 * Small async-queue used to hand off events from the realtime voice listeners
 * to the SSE writer. The writer awaits `next()`; listeners call `push()`.
 */
class EventQueue {
  private buffer: SSEEvent[] = [];
  private waiter: ((ev: SSEEvent | null) => void) | null = null;
  private closed = false;

  push(ev: SSEEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
      return;
    }
    this.buffer.push(ev);
  }

  next(): Promise<SSEEvent | null> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
}

type VoiceSession = {
  id: string;
  queue: EventQueue;
  listeners: Array<{ event: string; handler: Listener }>;
};

/**
 * Demo-scope: a single active voice session at a time. The OpenAIRealtimeVoice
 * instance is owned by the agent (designer.voice), so starting a new session
 * tears down any previous one before reconnecting.
 */
let active: VoiceSession | null = null;

function newSessionId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function teardown(s: VoiceSession): Promise<void> {
  s.queue.close();
  try {
    const v = await designer.getVoice();
    // Remove all event listeners before closing
    for (const { event, handler } of s.listeners) {
      (v.off as unknown as (e: string, c: Listener) => void)(event, handler);
    }
    v.close();
  } catch {
    /* already closed */
  }
  if (active?.id === s.id) active = null;
}

/**
 * Loose listener shape — the underlying provider emits runtime payloads that
 * are richer than `MastraVoice`'s strict `VoiceEventMap` typings (e.g.
 * `speaking` delivers `{ audio: Buffer, response_id }` but the map types it
 * as `{ audio?: string }`). We type our listeners against the actual runtime
 * shape, sourced from `@mastra/voice-openai-realtime`'s emit calls.
 */
type Listener = (payload: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

function attachVoiceListeners(
  s: VoiceSession,
  voice: Awaited<ReturnType<typeof designer.getVoice>>,
): void {
  const on = (event: string, cb: Listener) => {
    s.listeners.push({ event, handler: cb });
    (voice.on as unknown as (e: string, c: Listener) => void)(event, cb);
  };

  on("speaking", (payload: { audio: Buffer | Uint8Array; response_id?: string }) => {
    const bytes = Buffer.isBuffer(payload.audio)
      ? payload.audio
      : Buffer.from(payload.audio);
    s.queue.push({
      event: "audio",
      data: JSON.stringify({
        b64: bytes.toString("base64"),
        responseId: payload.response_id,
      }),
    });
  });

  on("speaking.done", (payload: { response_id?: string }) => {
    s.queue.push({
      event: "audio.done",
      data: JSON.stringify({ responseId: payload.response_id }),
    });
  });

  on(
    "writing",
    (payload: { text: string; role: "user" | "assistant"; response_id?: string }) => {
      s.queue.push({
        event: "transcript",
        data: JSON.stringify({
          text: payload.text,
          role: payload.role,
          responseId: payload.response_id,
        }),
      });
    },
  );

  on("tool-call-result", (payload: unknown) => {
    s.queue.push({ event: "state", data: JSON.stringify(getState()) });
    s.queue.push({ event: "tool", data: JSON.stringify(payload) });
  });

  on("response.done", () => {
    s.queue.push({ event: "state", data: JSON.stringify(getState()) });
    s.queue.push({ event: "turn.done", data: "{}" });
  });

  on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    s.queue.push({ event: "error", data: JSON.stringify({ message }) });
  });
}

/** POST /api/voice/start — open a realtime session, return its id. */
const startRoute: Middleware = {
  path: "/api/voice/start",
  handler: async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      return c.json({ error: "OPENAI_API_KEY is not set" }, 503);
    }

    if (active) await teardown(active);

    const session: VoiceSession = { id: newSessionId(), queue: new EventQueue(), listeners: [] };
    active = session;

    try {
      const voice = await designer.getVoice();
      attachVoiceListeners(session, voice);
      await voice.connect();
    } catch (err) {
      await teardown(session);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to connect realtime voice: ${message}` }, 500);
    }

    session.queue.push({ event: "state", data: JSON.stringify(getState()) });

    return c.json({ sessionId: session.id });
  },
};

/** POST /api/voice/append?sid=... — raw PCM16 mono @ 24kHz bytes. */
const appendRoute: Middleware = {
  path: "/api/voice/append",
  handler: async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const sid = c.req.query("sid");
    if (!active || active.id !== sid) {
      return c.json({ error: "no active session" }, 409);
    }

    const buf = await c.req.arrayBuffer();
    if (buf.byteLength === 0) return c.json({ ok: true });
    if (buf.byteLength % 2 !== 0) {
      return c.json({ error: "audio payload must be 16-bit aligned" }, 400);
    }

    const int16 = new Int16Array(buf);
    try {
      const voice = await designer.getVoice();
      await voice.send(int16);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `send failed: ${message}` }, 500);
    }
    return c.json({ ok: true });
  },
};

/** POST /api/voice/stop?sid=... — close the session. */
const stopRoute: Middleware = {
  path: "/api/voice/stop",
  handler: async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const sid = c.req.query("sid");
    if (active && active.id === sid) {
      await teardown(active);
    }
    return c.json({ ok: true });
  },
};

/** GET /api/voice/events?sid=... — SSE stream of audio + transcript + state. */
const eventsRoute: Middleware = {
  path: "/api/voice/events",
  handler: async (c, next) => {
    if (c.req.method !== "GET") {
      await next();
      return;
    }
    const sid = c.req.query("sid");
    if (!active || active.id !== sid) {
      return c.text("no active session", 409);
    }
    const session = active;

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        session.queue.close();
      });

      // Heartbeat so proxies don't drop idle connections.
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {
          /* stream closed */
        });
      }, 15_000);

      try {
        while (true) {
          const ev = await session.queue.next();
          if (ev === null) break;
          await stream.writeSSE(ev);
        }
        await stream.writeSSE({ event: "closed", data: "{}" });
      } finally {
        clearInterval(heartbeat);
      }
    });
  },
};

export const voiceMiddleware: Middleware[] = [
  startRoute,
  appendRoute,
  stopRoute,
  eventsRoute,
];
