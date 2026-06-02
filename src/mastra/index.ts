import { Mastra } from "@mastra/core/mastra";
import { createDesigner } from "./agents/designer";
import { createSiteState } from "./state/site-state";

/* Studio-only entrypoint, bundled by `mastra build --studio`.
 *
 * The public server (src/index.ts) never imports this — it builds a fresh
 * agent + state store per voice session. This instance exists so Mastra
 * Studio can introspect and exercise the designer agent at /admin. Studio
 * sessions share this one state store, which is fine: it's a tuning surface,
 * not the public page.
 *
 * apiPrefix/studioBase put ALL of Studio (UI + API) under /admin, so the
 * main server can gate and proxy a single path prefix. */

export const mastra = new Mastra({
  agents: { designer: createDesigner(createSiteState()) },
  server: {
    apiPrefix: "/admin/api",
    studioBase: "/admin",
  },
});
