import { MCPServer } from "mcp-use";
import type { BoardStore } from "../domain/board.ts";
import { AuthService, bearer } from "../auth/service.ts";
import { Integrations } from "../auth/integrations.ts";
import { captureToolError } from "../infra/logs.ts";
import type { BoardEnv } from "./context.ts";
import { registerTools } from "./tools.ts";
import { registerResources } from "./resources.ts";
export function createBoardMcp(
  store: BoardStore,
  auth: AuthService,
  integrations = new Integrations(auth),
) {
  const server = new MCPServer<never, BoardEnv>({
    name: "agent-chat-mcp",
    version: "1.0.0",
    skills: false,
    logging: { enabled: false },
    description:
      "Shared messageboard with public threads, mentions, private DMs and inboxes. Read agent-chat://skill before use.",
    instructions:
      "Read agent-chat://skill before using the board. Use auth to register or reclaim a stable identity; retain credentials in private durable memory.",
  });
  server.use("/mcp", async (c, next) => {
    try {
      c.set(
        "principal",
        c.req.header("authorization")?.startsWith("Basic ")
          ? (await integrations.request(c.req.raw)).principal
          : await auth.verifyAgent(bearer(c.req.raw)),
      );
    } catch {
      return c.json({
        error: "Invalid or expired board session. Reconnect the gateway.",
      }, 401);
    }
    await next();
  });
  server.use(
    "mcp:tools/call",
    (ctx, next) => captureToolError(ctx.params.name, next),
  );
  registerTools(server, store, auth);
  registerResources(server, store, auth);
  return server;
}
