/* ---------- /admin — auth-gated Mastra Studio ----------
 *
 * Mastra's server can't host our custom voice WebSocket (registerApiRoute is
 * HTTP-only), so the public app and Studio run as TWO processes in one
 * service: this server owns $PORT, and the Mastra server (built with
 * `mastra build --studio`) runs as a child on an internal port. Everything
 * under /admin — Studio UI *and* its API (apiPrefix is /admin/api, see
 * src/mastra/index.ts) — is reverse-proxied to the child behind basic auth.
 *
 * Auth accepts an Authorization header OR a signed session cookie. The cookie
 * matters for WebSockets: browsers won't attach basic-auth credentials to a
 * WS handshake, but they do send cookies, and Studio's playground voice chat
 * rides a WS at /admin/api/agents/:id/browser/session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

// Node's built-in fetch enforces a 5-minute body timeout — fatal for Studio's
// long-lived SSE streams (refresh-events), which it terminates MID-PIPE as an
// uncatchable async error. Proxy through undici directly with timeouts off.
const proxyDispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });

const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 4112);
const USER = process.env.ADMIN_USERNAME ?? "";
const PASS = process.env.ADMIN_PASSWORD ?? "";

export const adminConfigured = USER.length > 0 && PASS.length > 0;

/* ---------- auth ---------- */

const COOKIE_NAME = "mastra_admin";

// Stable per-credential token; rotating the password invalidates sessions.
const sessionToken = adminConfigured
  ? createHmac("sha256", `${USER}:${PASS}`).update("admin-session-v1").digest("hex")
  : "";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function headerAuthorized(authorization: string | undefined): boolean {
  if (!authorization) return false;
  const expected = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  return safeEqual(authorization, expected);
}

function cookieAuthorized(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME && safeEqual(rest.join("="), sessionToken)) return true;
  }
  return false;
}

function isAuthorized(authorization: string | undefined, cookie: string | undefined): boolean {
  return adminConfigured && (headerAuthorized(authorization) || cookieAuthorized(cookie));
}

const UNAUTHORIZED_HEADERS = {
  "WWW-Authenticate": 'Basic realm="design-agent admin"',
} as const;

/* ---------- HTTP proxy ---------- */

export async function adminProxy(c: Context): Promise<Response> {
  if (!adminConfigured) {
    return c.json(
      { error: "Admin is disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD to enable /admin." },
      503,
    );
  }
  const authorization = c.req.header("authorization");
  const cookie = c.req.header("cookie");
  if (!isAuthorized(authorization, cookie)) {
    return c.body("Unauthorized", 401, UNAUTHORIZED_HEADERS);
  }

  const url = new URL(c.req.url);
  const target = `http://127.0.0.1:${STUDIO_PORT}${url.pathname}${url.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.set("host", `127.0.0.1:${STUDIO_PORT}`);
  headers.delete("authorization"); // credentials stop at the proxy

  // Casts: undici ships its own copies of the fetch web types, which don't
  // structurally match lib.dom's — identical at runtime.
  const init: Record<string, unknown> = {
    method: c.req.method,
    headers,
    redirect: "manual",
    dispatcher: proxyDispatcher,
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = c.req.raw.body;
    init.duplex = "half";
  }

  let upstream: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    upstream = await undiciFetch(target, init as Parameters<typeof undiciFetch>[1]);
  } catch {
    return c.json({ error: "Studio backend is not running." }, 502);
  }

  const respHeaders = new Headers(upstream.headers as unknown as HeadersInit);
  // fetch() already decompressed the body — drop stale encoding headers.
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  if (!cookieAuthorized(cookie)) {
    respHeaders.append(
      "set-cookie",
      `${COOKIE_NAME}=${sessionToken}; Path=/admin; HttpOnly; SameSite=Strict`,
    );
  }
  return new Response(upstream.body as unknown as BodyInit | null, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/* ---------- WebSocket proxy ----------
 *
 * Raw TCP tunnel: re-serialize the upgrade request to the child, then pipe
 * bytes both ways. Returns true when the request was an /admin upgrade (so
 * the caller skips other upgrade handlers).
 */

export function handleAdminUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = req.url ?? "";
  if (url !== "/admin" && !url.startsWith("/admin/")) return false;

  if (!isAuthorized(req.headers.authorization, req.headers.cookie)) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        `WWW-Authenticate: ${UNAUTHORIZED_HEADERS["WWW-Authenticate"]}\r\n` +
        "Connection: close\r\n\r\n",
    );
    socket.destroy();
    return true;
  }

  const upstream = net.connect(STUDIO_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value =
        name.toLowerCase() === "host" ? `127.0.0.1:${STUDIO_PORT}` : req.rawHeaders[i + 1];
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const destroyBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", destroyBoth);
  socket.on("error", destroyBoth);
  return true;
}

/* ---------- Studio child process ---------- */

export function startStudio(projectRoot: string): ChildProcess | null {
  if (!adminConfigured) {
    console.log("admin: /admin disabled — set ADMIN_USERNAME and ADMIN_PASSWORD to enable it");
    return null;
  }

  const builtEntry = path.join(projectRoot, ".mastra", "output", "index.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(STUDIO_PORT),
    MASTRA_HOST: "127.0.0.1",
    // Studio UI calls window.location.origin (the public domain), and the
    // proxy carries /admin/* back here — never the internal host/port.
    MASTRA_AUTO_DETECT_URL: "true",
  };

  let child: ChildProcess;
  if (existsSync(builtEntry)) {
    env.MASTRA_STUDIO_PATH = path.join(projectRoot, ".mastra", "output", "studio");
    child = spawn(process.execPath, [builtEntry], {
      env,
      cwd: projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true, // own process group so we can kill grandchildren
    });
    console.log(`admin: studio (built) starting on internal port ${STUDIO_PORT}`);
  } else {
    // No build output — local dev convenience: run `mastra dev` instead.
    child = spawn("npx", ["mastra", "dev"], {
      env,
      cwd: projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    console.log(`admin: studio (mastra dev) starting on internal port ${STUDIO_PORT}`);
  }

  const stop = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM"); // negative pid = whole group
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  return child;
}
