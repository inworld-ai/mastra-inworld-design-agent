import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { resetState } from "../state/site-state";

export const resetTool = createTool({
  id: "reset",
  description: "Restore the page to its default state (theme, type, copy, layout).",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async () => {
    resetState();
    return { ok: true as const };
  },
});
