import { createOpenAI } from "@ai-sdk/openai";

/**
 * OpenAI provider for text/reasoning (non-voice) interactions.
 * For voice interactions, the OpenAIRealtimeVoice provider handles everything.
 */
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

export const DEFAULT_OPENAI_MODEL = "gpt-4o";