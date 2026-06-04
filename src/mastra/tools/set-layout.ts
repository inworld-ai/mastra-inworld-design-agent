import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { SiteStateStore } from "../state/site-state";

const alignment = z.enum(["left", "center"]);
const heroVariant = z.enum(["split", "stacked", "minimal"]);

export function makeSetLayoutTool(siteState: SiteStateStore) {
  return createTool({
    id: "set_layout",
    description: "Update the page layout — alignment and hero variant.",
    inputSchema: z.object({
      alignment: alignment.optional().describe("Horizontal alignment of hero text"),
      heroVariant: heroVariant.optional().describe("Hero arrangement: split, stacked, or minimal"),
    }),
    outputSchema: z.object({
      alignment,
      heroVariant,
    }),
    execute: async (input) => {
      const next = siteState.setLayout(input);
      return next.layout;
    },
  });
}
