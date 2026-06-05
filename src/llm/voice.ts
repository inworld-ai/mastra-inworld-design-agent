import { InworldRealtimeVoice } from "@mastra/voice-inworld";
import type { MastraVoice } from "@mastra/core/voice";

// Brain for the realtime agent, routed through Inworld. Inworld-hosted
// gemma-26b. NOTE: gemma has historically mangled back-to-back tool-call
// arguments (the truncation bug) on multi-tool bursts — watch requests that
// fire several tools at once ("make it dark, swap the font, add a card"). If
// that resurfaces, set INWORLD_REALTIME_MODEL=openai/gpt-5.5 to switch back
// without a code change. STT + TTS stay on the SDK's Inworld defaults.
const DEFAULT_REALTIME_MODEL = "inworld/models/gemma-4-26b-a4b-it";

export function createVoice(): MastraVoice | null {
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) return null;
  // SDK defaults for turn-taking: semantic-VAD with interrupt_response: true,
  // awaitable speak(), barge-in surfaced as `interrupted`.
  // INWORLD_DEBUG=1 logs every realtime event — for diagnosing session wedges.
  const voice = new InworldRealtimeVoice({
    apiKey,
    model: process.env.INWORLD_REALTIME_MODEL ?? DEFAULT_REALTIME_MODEL,
    // Back-channels: short "mhm" / "right" acknowledgements voiced WHILE the
    // user is still speaking. They arrive on the dedicated `backchannel` event
    // (a separate stream from main TTS), carry back-channel ids that never
    // appear in `interrupted`, and are exempt from barge-in by design — the
    // server relays them on their own frame type and the client plays them on a
    // player that `stopAllAudio()` never touches, so they're never cancelled.
    // NOTE: gated by Inworld account prerequisites; if it's not enabled for the
    // key, no `backchannel` audio fires (watch for `backchannel.skipped`).
    providerData: { backchannel: { enabled: true } },
    debug: process.env.INWORLD_DEBUG === "1",
  });
  // Cast: voice packages bundle their own copy of MastraVoice's base class,
  // whose ECMAScript private brand differs from the @mastra/core copy. The
  // two are interchangeable at runtime; only the structural type check trips.
  return voice as unknown as MastraVoice;
}
