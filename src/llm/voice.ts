import { OpenAIRealtimeVoice } from "@mastra/voice-openai-realtime";
import type { MastraVoice } from "@mastra/core/voice";

/**
 * Factory for the realtime voice provider attached to the designer agent.
 *
 * Today: OpenAI Realtime. When `@mastra/voice-inworld-realtime` ships, swap
 * the import + constructor below and the rest of the app is unchanged — the
 * provider class implements `MastraVoice`, and the agent / server wiring
 * talks to that interface only.
 *
 * Returns `null` when no API key is configured so the rest of the app can
 * boot (text-only mode) without crashing.
 */
export function createVoice(): MastraVoice | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAIRealtimeVoice({
    apiKey,
    speaker: "alloy",
  });
}

export const VOICE_SAMPLE_RATE = 24_000;
