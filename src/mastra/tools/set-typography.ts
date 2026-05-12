import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { setTypography } from "../state/site-state";

export const setTypographyTool = createTool({
  id: "set_typography",
  description:
    "Update typography. `fontFamily` is a Google Fonts family name loaded at runtime.",
  inputSchema: z.object({
    fontFamily: z
      .string()
      .min(1)
      .optional()
      .describe("Google Fonts family, e.g. 'Inter', 'IBM Plex Serif'"),
    scale: z
      .number()
      .min(0.75)
      .max(2)
      .optional()
      .describe("Overall type-scale multiplier (1 = default)"),
  }),
  outputSchema: z.object({
    fontFamily: z.string(),
    scale: z.number(),
  }),
  execute: async (input) => {
    const next = setTypography(input);
    return next.typography;
  },
});
