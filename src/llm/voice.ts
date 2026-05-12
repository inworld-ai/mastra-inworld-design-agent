import { OpenAIRealtimeVoice } from "@mastra/voice-openai-realtime";
import type { MastraVoice } from "@mastra/core/voice";

/**
 * Factory for the OpenAI Realtime voice provider.
 * Returns null when no API key is configured for graceful text-only fallback.
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
