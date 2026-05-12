import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Next } from "hono";

/**
 * Locate the project's `public/` directory regardless of where the entry
 * point ended up. `mastra dev` and `mastra build` both run from rewritten
 * working directories (`.mastra/output/`), so `process.cwd()` is unreliable.
 *
 * Resolution order:
 *   1. `MASTRA_PUBLIC_DIR` env var (explicit override)
 *   2. Walk up from this file's location (works when sources are bundled
 *      somewhere under the project root)
 *   3. Walk up from `process.cwd()`
 */
async function resolvePublicDir(): Promise<string> {
  if (process.env.MASTRA_PUBLIC_DIR) {
    return path.resolve(process.env.MASTRA_PUBLIC_DIR);
  }

  const seeds: string[] = [];
  try {
    seeds.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* not an ESM file URL — skip */
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

  // Last-resort fallback so the type is always a string; reads will 404.
  return path.resolve(process.cwd(), "public");
}

const publicDirPromise = resolvePublicDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Serve files from ./public for non-API GETs. Falls through to Mastra's
 * router for anything that doesn't resolve to a file on disk.
 *
 * Registered on both `/` and `/*` because Hono's `/*` pattern does NOT match
 * the bare root path — without the explicit `/` route, Mastra Studio's
 * `app.get("*", ...)` catch-all (registered after user middleware) ends up
 * serving its own index.html for `/`.
 */
function makeHandler(): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    if (c.req.method !== "GET") {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // Skip API routes and Studio paths
    if (pathname.startsWith("/api/") ||
        pathname.startsWith("/studio") ||
        pathname.startsWith("/dashboard") ||
        pathname.startsWith("/_")) {
      await next();
      return;
    }

    const publicDir = await publicDirPromise;
    const filePath = path.resolve(publicDir, "." + pathname);
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
      await next();
      return;
    }

    try {
      const body = await readFile(filePath);
      const mime = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": mime } });
    } catch {
      await next();
      return;
    }
  };
}

export const staticMiddleware: { path: string; handler: ReturnType<typeof makeHandler> }[] = [
  { path: "/", handler: makeHandler() },
  { path: "/*", handler: makeHandler() },
];
