import { InworldRealtimeVoice } from "@mastra/voice-inworld";
import type { MastraVoice } from "@mastra/core/voice";

export function createVoice(): MastraVoice | null {
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) return null;
  // SDK defaults all the way: Inworld-hosted LLM, STT, and TTS voice,
  // semantic-VAD turn detection with interrupt_response: true, awaitable
  // speak(), barge-in surfaced as `interrupted`. No overrides needed.
  const voice = new InworldRealtimeVoice({ apiKey });
  // Cast: voice packages bundle their own copy of MastraVoice's base class,
  // whose ECMAScript private brand differs from the @mastra/core copy. The
  // two are interchangeable at runtime; only the structural type check trips.
  return voice as unknown as MastraVoice;
}
