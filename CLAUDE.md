# Claude / agent notes — mastra-design-agent

Context for AI coding agents working in this project.

## What this is

A Mastra agent that redesigns a landing page via tool calls. Voice is `InworldRealtimeVoice` from the published `@mastra/voice-inworld` (npm alpha tag); the agent's text-path model routes through Inworld's OpenAI-compatible router. Tools mutate per-session state; the frontend re-renders on WS state snapshots.

## Development

```bash
npm install
cp .env.example .env  # set INWORLD_API_KEY (+ ADMIN_USERNAME/ADMIN_PASSWORD for /admin)
npm run dev           # localhost:4111
npm run typecheck     # tsc --noEmit (tsconfig is noEmit — nothing ever compiles to dist/)
npm run build         # mastra build --studio → .mastra/output (only needed for /admin + deploy)
```

## File structure

```
src/
├── index.ts            # public server: static, /api/state, /api/voice WS, /admin glue
├── admin.ts            # basic auth, HTTP + WS reverse proxy, Studio child process
├── llm/
│   ├── openai.ts       # text-path provider (Inworld router, NOT api.openai.com)
│   └── voice.ts        # InworldRealtimeVoice factory
└── mastra/
    ├── index.ts        # Mastra instance — ONLY for Studio (`mastra build --studio`)
    ├── store.ts        # shared LibSQL storage (Studio edits DB, both processes)
    ├── resolve-instructions.ts  # public-server reader for published Studio edits
    ├── agents/designer.ts
    ├── state/site-state.ts
    └── tools/          # 10 tool definitions
public/                 # vanilla JS frontend, no build step
```

## Architecture invariants

- **Per-session isolation**: src/index.ts builds a fresh agent + state store + voice connection per voice WS. Never introduce shared mutable site state on the public path.
- **Two processes**: Mastra's server can't host custom WebSockets, so the public server owns $PORT and reverse-proxies /admin/* to a mastra-built child on STUDIO_PORT (loopback). src/mastra/index.ts is the child's entrypoint and is never imported by src/index.ts.
- **apiPrefix/studioBase are both /admin-rooted** (src/mastra/index.ts) so the proxy + auth cover Studio's UI and API with one path rule.
- **Auth**: Authorization header OR signed session cookie. The cookie exists because browser WS handshakes can't carry basic-auth headers (Studio playground voice WS needs it).
- **Upgrade dispatch**: @hono/node-ws kills upgrades it doesn't own; src/index.ts re-dispatches 'upgrade' events — /admin first, then node-ws listeners. Keep that ordering.
- **Studio→live bridge**: both processes share a LibSQL file (store.ts). Studio saves instruction edits to mastra_agents/mastra_agent_versions; the public server resolves the published version per session (resolve-instructions.ts, clearCache before each read — the write happens in the other process). The designer AGENT's `editor` config field (not the Mastra instance's `editor: new MastraEditor()` — that stays) is deliberately OMITTED: omitted means code instructions are the baseline AND Studio can override; `editor: { instructions: true }` would forbid code instructions entirely.
- **Text-path model**: llm/openai.ts must use `provider.chat(id)` — the bare provider call builds a Responses-API model (POST /v1/responses) which Inworld's router doesn't serve (404).

## Key points

- **Tools**: Never use `{context}` — tools receive `input` directly
- **State**: Tools mutate via setters in `state/site-state.ts`, don't reassign
- **Paths**: Use `import.meta.url` not `process.cwd()` for file resolution
- **Versions**: @mastra/* pinned to alpha tags (core, voice-inworld, editor, libsql, mastra CLI); `.npmrc` has legacy-peer-deps (npm prerelease range semantics). When stable 0.3.0 / 1.38 land, unpin and drop .npmrc.
- **Voice casts**: voice packages bundle their own MastraVoice base class copy — the `as unknown as MastraVoice` casts are load-bearing until upstream extracts a shared base
- **Environment**: one INWORLD_API_KEY covers voice + text model; key is pre-Base64-encoded, pass verbatim

## Testing

- Typecheck: `npm run typecheck`
- Boot: `npm run dev` → `/api/state` returns JSON
- Voice E2E: open localhost:4111, start voice, "make background dark" updates preview
- Admin: with creds set, `curl -u user:pass localhost:4111/admin` → Studio HTML; without → 401
