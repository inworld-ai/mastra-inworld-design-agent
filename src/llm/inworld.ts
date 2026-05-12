import { createOpenAI } from "@ai-sdk/openai";

/**
 * AI-SDK provider pointed at the Inworld LLM Router.
 *
 * Inworld's router is OpenAI-compatible at /v1/chat/completions, but expects
 * `Authorization: Basic <key>` — the env value is already Basic-encoded per
 * project convention. We pass it through verbatim in a custom header so the
 * underlying client does not emit the default `Bearer` scheme.
 */
const apiKey = process.env.INWORLD_API_KEY ?? "";

export const inworld = createOpenAI({
  baseURL: "https://api.inworld.ai/v1",
  apiKey,
  headers: {
    Authorization: `Basic ${apiKey}`,
  },
});

export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4-6";
