import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { SiteStateStore } from "../state/site-state";

const preset = z.enum(["default", "dark", "cream", "ocean", "sunset", "mono", "forest", "neon"]);

export function makeApplyPresetTool(siteState: SiteStateStore) {
  return createTool({
    id: "apply_preset",
    description:
      "Apply a named visual preset (palette + sometimes font). Useful as a one-shot reskin.",
    inputSchema: z.object({
      name: preset.describe("Preset name"),
    }),
    outputSchema: z.object({
      name: preset,
      theme: z.object({ bg: z.string(), text: z.string(), accent: z.string() }),
      fontFamily: z.string(),
    }),
    execute: async (input) => {
      const next = siteState.applyPreset(input.name);
      return { name: input.name, theme: next.theme, fontFamily: next.typography.fontFamily };
    },
  });
}
