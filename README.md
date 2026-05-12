# Mastra Design Agent

A Mastra agent that redesigns a live landing page via OpenAI tool calls. Features both text and voice chat interfaces powered by OpenAI's GPT-4o and Realtime API.

## What's Included

- **OpenAI Integration** — GPT-4o for text reasoning, OpenAI Realtime for voice interactions
- **Mastra Agent** — `designer` with 5 tools: `set_theme`, `set_typography`, `set_copy`, `set_layout`, `reset`
- **Tool-Driven UI** — Every visual change is a structured tool call, visible in the chat
- **Voice + Text Chat** — Seamless switching between typing and speaking to the agent
- **Live Preview** — Right pane updates in real-time as tools execute
- **No-Build Frontend** — Vanilla HTML/CSS/JS for simplicity

## Demo

The agent can redesign the landing page through natural conversation:

- **"Make the background dark and the text white"** → calls `set_theme({bg: "#1a1a1a", text: "#ffffff"})`
- **"Change the font to something modern"** → calls `set_typography({fontFamily: "Inter"})`
- **"Make the headline say 'Welcome'"** → calls `set_copy({slot: "headline", text: "Welcome"})`
- **Voice**: Click "Start voice" and speak your design requests

## Setup & Development

```bash
git clone <repo-url>
cd mastra-inworld-design-agent
npm install
cp .env.example .env
```

Add your OpenAI API key to `.env`:
```env
OPENAI_API_KEY=sk-...
```

Then run:
```bash
npm run dev  # Starts dev server with hot-reload
```

Open http://localhost:4111 and start chatting with the designer!

## Deployment

Deploy to Render with one click using the included `render.yaml`. Just:

1. Connect your repo to Render
2. Set `OPENAI_API_KEY` in the Render dashboard
3. Deploy!

The app will be available at your Render URL.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | yes | OpenAI API key for both text and voice. Get one at [platform.openai.com](https://platform.openai.com). |
| `PORT` | no | Server port. Defaults to 4111 locally, Render injects automatically. |

## Architecture

```
src/
├── mastra/
│   ├── agents/designer.ts  # Main agent with OpenAI model + tools
│   ├── tools/              # 5 tool definitions with Zod schemas
│   └── state/site-state.ts # Shared mutable state
├── server/
│   ├── routes.ts           # /api/state, /api/chat endpoints
│   ├── static.ts           # Serves public/ directory
│   └── voice.ts            # OpenAI Realtime voice integration
├── llm/
│   ├── openai.ts           # OpenAI provider for text
│   └── voice.ts            # OpenAI Realtime provider factory
public/                     # Frontend (no build step)
├── index.html              # Split-view interface
├── app.js                  # Chat + voice + rendering logic
└── styles.css              # Dark theme styling
```

**Key Features:**

- **Pure OpenAI**: Both text and voice use OpenAI models (GPT-4o + Realtime)
- **Tool Visibility**: Every tool call shows in chat with full JSON parameters
- **Voice Integration**: OpenAI Realtime handles audio I/O + reasoning seamlessly
- **State Management**: Tools mutate shared state, frontend re-renders on updates
- **No Build Step**: Public assets served directly for rapid iteration

## How It Works

1. **Text Chat**: User types → GPT-4o → tool calls → state update → UI refresh
2. **Voice Chat**: User speaks → OpenAI Realtime → tool calls → state update → voice response
3. **Tools**: Each tool has Zod schema validation and mutates the site state
4. **Frontend**: Polls state after each interaction and re-renders the preview

## Development Notes

- State is in-memory (resets on restart) - perfect for demos
- Tools are designed to be atomic and composable
- Voice and text share the same tool surface - consistent experience
- Frontend intentionally simple to focus on the agent capabilities

## Contributing

This is a reference implementation for Mastra + OpenAI integration. Feel free to:

- Add new tools for different design aspects
- Enhance the frontend with more preview options  
- Add persistence for state management
- Integrate additional OpenAI capabilities