import type { Context, Next } from "hono";
import { designer } from "../mastra/agents/designer";
import { getState } from "../mastra/state/site-state";

type Middleware = {
  path: string;
  handler: (c: Context, next: Next) => Promise<Response | void>;
};

/** GET /api/state — current siteState as JSON. */
export const stateRoute: Middleware = {
  path: "/api/state",
  handler: async (c, next) => {
    if (c.req.method !== "GET") {
      await next();
      return;
    }
    return c.json(getState());
  },
};

type ChatBody = {
  message?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

/**
 * POST /api/chat — run the designer agent for one turn and return the
 * updated state alongside the agent's text reply.
 */
export const chatRoute: Middleware = {
  path: "/api/chat",
  handler: async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }

    let body: ChatBody;
    try {
      body = await c.req.json<ChatBody>();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }

    const messages = body.messages?.length
      ? body.messages
      : body.message
        ? [{ role: "user" as const, content: body.message }]
        : null;

    if (!messages) {
      return c.json({ error: "expected `messages` or `message`" }, 400);
    }

    const result = await designer.generate(messages);

    return c.json({
      text: result.text ?? "",
      state: getState(),
      toolCalls: result.toolCalls?.map(call => ({
        tool: call.toolName,
        args: call.args,
      })) || [],
    });
  },
};

export const apiMiddleware: Middleware[] = [stateRoute, chatRoute];
