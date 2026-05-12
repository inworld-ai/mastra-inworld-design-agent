# Claude / agent notes — mastra-design-agent

Context for AI coding agents (Claude Code, Cursor, etc.) working in this project.

## What this is

A Mastra agent that redesigns a live landing page via tool calls. Uses OpenAI's GPT-4o for text reasoning and OpenAI Realtime for voice interactions. The agent never emits HTML — it calls typed tools that mutate a shared `siteState`, and the frontend re-renders the preview from that state.

## Toolchain

- **Node ≥ 20** (declared in `package.json` `engines`). No version manager pin file; if Node-version managers (`nvm`, `fnm`, `volta`) are in the environment, anything `>=20` works.
- **npm** for install and scripts. The `mastra` CLI is the build / dev driver:
  - `npm install`
  - `npm run dev` — `mastra dev`. Hot-reloads on `src/` changes. Same routes as prod.
  - `npm run build` — produces `.mastra/output/` (bundled).
  - `node .mastra/output/index.mjs` — run the production bundle.

Both modes serve the design-agent UI at `/`. The `public/` directory is not copied into `.mastra/output/` by the bundler; the static middleware walks up from `import.meta.url` to find it, which works in dev (running from a temp dir) and in prod (running from `.mastra/output/`). Override with `MASTRA_PUBLIC_DIR` if a deployment needs an explicit path.

If `npm install` fails on a corporate registry, `.npmrc` is intentionally absent at the project level so the user's global registry config wins. Do not commit a project-level `.npmrc` unless adding a specific scope override (and document why).

## File map

```
src/
├── mastra/
│   ├── index.ts            # Mastra({ agents, server.middleware })
│   ├── agents/designer.ts  # Agent — system prompt + tools
│   ├── tools/              # 5 createTool exports (zod inputs)
│   └── state/site-state.ts # Shared mutable siteState + getters/setters
├── server/
│   ├── routes.ts           # Middleware for /api/state, /api/chat
│   ├── static.ts           # Middleware that serves ./public
│   └── voice.ts            # OpenAI Realtime voice session management
└── llm/
    ├── openai.ts           # createOpenAI for text interactions
    └── voice.ts            # OpenAI Realtime provider factory
public/                     # index.html, app.js, styles.css — no build step
```

## When making changes

- **OpenAI API key** is standard bearer token format. Used for both text (GPT-4o) and voice (Realtime API).
- **Default model is `gpt-4o`** (defined in `src/llm/openai.ts`). Change via `DEFAULT_OPENAI_MODEL`.
- **Voice provider** uses `OpenAIRealtimeVoice` from `@mastra/voice-openai-realtime`. It handles audio I/O and reasoning in one unified flow.
- **Tools mutate `siteState` in-place via the setters in `state/site-state.ts`.** Don't reassign the state object — getters return a snapshot, setters merge. The frontend reads state after each chat turn.
- **The agent's system prompt forbids raw HTML.** All design changes go through tools. If a new design knob is needed, add a new tool (with a Zod schema), don't loosen the prompt.
- **Mastra reserves `/api/`.** Custom endpoints (`/api/state`, `/api/chat`, `/api/voice/*`) are mounted as `server.middleware`, not `registerApiRoute` — middleware can intercept before Mastra's 404.
- **Hono's `/*` does NOT match `/`.** The static middleware is registered on both `/` and `/*` for that reason. Without the explicit `/` entry, Mastra Studio's catch-all would interfere.
- **`process.cwd()` is unreliable.** `mastra dev` and `mastra build` both run from rewritten working directories. Anything that needs to find files in the project (the `public/` dir, `.env`, etc.) should resolve from `import.meta.url` and walk up, not from `process.cwd()`. See `src/server/static.ts` for the pattern.
- **State is process-local.** Every restart resets defaults. This is intentional for a demo; do not add persistence without an explicit ask.
- **Tool calls are visible in chat.** Both text and voice modes show tool calls with full JSON parameters in the conversation UI.

## Running locally

```bash
npm install
cp .env.example .env       # set OPENAI_API_KEY
npm run dev
```

Boot smoke test: process starts without errors, `GET /api/state` returns default JSON, `GET /` returns the split-view HTML.

End-to-end test: open `http://localhost:4111/`, type "make the background dark and the headline say 'Hello'" — expect the preview to update.

Voice test: click "Start voice" and speak a design request — expect voice response and UI update.

## Env

- `OPENAI_API_KEY` (required) — standard OpenAI API key for both text and voice.
- `PORT` (optional) — `mastra dev` defaults to **4111** if unset. For different port set in `.env`.
- `MASTRA_PUBLIC_DIR` (optional) — explicit override for the `public/` resolution.

## Deploy

Node web service on Render via `render.yaml`:
- build: `npm install && npm run build`
- start: `node .mastra/output/index.mjs`

Set `OPENAI_API_KEY` in Render dashboard environment variables.

## Architecture notes

Clean OpenAI-only architecture:
- **Text chat**: OpenAI GPT-4o → Mastra tools → state update
- **Voice chat**: OpenAI Realtime → Mastra tools → state update

No hybrid providers or sidecars. OpenAI handles both reasoning and voice I/O. Mastra bridges the tools automatically to OpenAI's native tool calling protocol.

Voice and text modes share the same tool surface for consistent UX. Frontend polls state after each interaction and re-renders the preview.