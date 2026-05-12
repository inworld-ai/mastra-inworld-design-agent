import { Mastra } from "@mastra/core";
import { designer } from "./agents/designer";
import { apiMiddleware } from "../server/routes";
import { voiceMiddleware } from "../server/voice";
import { staticMiddleware } from "../server/static";

export const mastra = new Mastra({
  agents: { designer },
  server: {
    middleware: [...apiMiddleware, ...voiceMiddleware, ...staticMiddleware],
  },
});
