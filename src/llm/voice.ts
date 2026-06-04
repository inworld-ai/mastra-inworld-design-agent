import { InworldRealtimeVoice } from "@mastra/voice-inworld";
import type { MastraVoice } from "@mastra/core/voice";

// Brain for the realtime agent, routed through Inworld. GPT-5.5 is the
// default: it handles the 10-tool surface reliably, including multi-tool
// bursts. (The Inworld-hosted gemma default mangles back-to-back tool-call
// arguments — see the truncation bug — so we pin a model that doesn't.)
// STT + TTS stay on the SDK's Inworld defaults. Override via env if desired.
const DEFAULT_REALTIME_MODEL = "openai/gpt-5.5";

export function createVoice(): MastraVoice | null {
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) return null;
  // SDK defaults for turn-taking: semantic-VAD with interrupt_response: true,
  // awaitable speak(), barge-in surfaced as `interrupted`.
  // INWORLD_DEBUG=1 logs every realtime event — for diagnosing session wedges.
  const voice = new InworldRealtimeVoice({
    apiKey,
    model: process.env.INWORLD_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL,
    debug: process.env.INWORLD_DEBUG === "1",
  });
  // Cast: voice packages bundle their own copy of MastraVoice's base class,
  // whose ECMAScript private brand differs from the @mastra/core copy. The
  // two are interchangeable at runtime; only the structural type check trips.
  return voice as unknown as MastraVoice;
}
