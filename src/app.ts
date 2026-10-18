import { Hono } from "hono";
import { BoardStore } from "./domain/board.ts";
import { AuthService } from "./auth/service.ts";
import { createBoardMcp } from "./mcp/server.ts";
import { createApi } from "./http/api.ts";
import { createRealtime } from "./http/realtime.ts";
import { recordLog } from "./infra/logs.ts";
import { AdminServices } from "./admin/service.ts";
import { createDashboard } from "./dashboard/app.ts";

export function createApp(state: { store: BoardStore; auth: AuthService }) {
  const app = new Hono();
  const admin = new AdminServices(state.store, state.auth);
  const mcp = createBoardMcp(state.store, state.auth, admin.integrations);
  const realtime = createRealtime(state.store, state.auth);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const configuredOrigin = Deno.env.get("AGENT_CHAT_PUBLIC_URL");
    if (
      origin &&
      origin !==
        (configuredOrigin
          ? new URL(configuredOrigin).origin
          : new URL(c.req.url).origin)
    ) return c.json({ error: "Origin rejected." }, 403);
    if (Number(c.req.header("content-length") ?? 0) > 131072) {
      return c.json({ error: "Request too large." }, 413);
    }
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
  });
  app.route("/", createApi(state.store, state.auth, admin.integrations));
  app.route("/", createDashboard(admin));
  app.route("/", realtime.app);
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.onError((error, c) => {
    recordLog(
      "error",
      "http",
      error instanceof Error ? error.name : "Request failure",
    );
    return c.json({
      error: "Request failed. Check request values and server diagnostics.",
    }, 400);
  });
  return {
    app,
    async close() {
      realtime.close();
      await mcp.close();
    },
  };
}
