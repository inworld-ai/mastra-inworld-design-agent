import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { setTheme } from "../state/site-state";

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex string");

export const setThemeTool = createTool({
  id: "set_theme",
  description:
    "Update the page theme colors. Pass only the fields you want to change.",
  inputSchema: z.object({
    bg: hex.optional().describe("Page background color"),
    text: hex.optional().describe("Primary text color"),
    accent: hex.optional().describe("Accent / CTA color"),
  }),
  outputSchema: z.object({
    bg: z.string(),
    text: z.string(),
    accent: z.string(),
  }),
  execute: async (input) => {
    const next = setTheme(input);
    return next.theme;
  },
});
