import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { setCopy } from "../state/site-state";

const slot = z.enum(["headline", "subheadline", "cta", "body"]);

export const setCopyTool = createTool({
  id: "set_copy",
  description: "Replace the text content of one copy slot on the page.",
  inputSchema: z.object({
    slot: slot.describe("Which slot to write to"),
    text: z.string().min(1).describe("New text for the slot"),
  }),
  outputSchema: z.object({
    slot,
    text: z.string(),
  }),
  execute: async (input) => {
    setCopy(input.slot, input.text);
    return { slot: input.slot, text: input.text };
  },
});
