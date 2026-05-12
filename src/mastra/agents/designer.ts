import { Agent } from "@mastra/core/agent";
import { DEFAULT_OPENAI_MODEL, openai } from "../../llm/openai";
import { createVoice } from "../../llm/voice";
import { setCopyTool } from "../tools/set-copy";
import { setLayoutTool } from "../tools/set-layout";
import { setThemeTool } from "../tools/set-theme";
import { setTypographyTool } from "../tools/set-typography";
import { resetTool } from "../tools/reset";

const instructions = `You are a design agent that redesigns a live landing page by calling tools.

Rules:
- Make every visual change through a tool call (set_theme, set_typography, set_copy, set_layout, reset). Never emit raw HTML, CSS, or markdown that tries to render UI.
- Pass only the fields you want to change. The tools merge into the current state.
- After calling tools, reply with ONE short sentence summarizing what you changed (e.g. "Switched the background to a warm cream and tightened the headline.").
- If a request is ambiguous, pick reasonable defaults and proceed — don't ask for permission for tiny taste decisions.
- If a request is impossible with the available tools (e.g. add a new feature card), say so plainly.`;

const voice = createVoice();

export const designer = new Agent({
  name: "designer",
  instructions,
  model: openai(DEFAULT_OPENAI_MODEL),
  tools: {
    set_theme: setThemeTool,
    set_typography: setTypographyTool,
    set_copy: setCopyTool,
    set_layout: setLayoutTool,
    reset: resetTool,
  },
  ...(voice ? { voice } : {}),
});
