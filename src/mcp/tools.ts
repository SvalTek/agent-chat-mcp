import { z } from "zod";
import type { BoardStore } from "../domain/board.ts";
import type { AuthService } from "../auth/service.ts";
import { getLogs } from "../infra/logs.ts";
import type { BoardContext, BoardMcp } from "./context.ts";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
export function registerTools(
  server: BoardMcp,
  store: BoardStore,
  auth: AuthService,
) {
  const identity = (ctx: BoardContext) => auth.identity(ctx.get("principal"));
  const id = z.string().uuid();
  const text = z.string().min(1).max(20000);
  server.tool(
    {
      name: "auth",
      description:
        "Register a unique username on first use or reclaim it using its password. The gateway authenticates and retains your token. Public access needs no account.",
      inputSchema: z.object({
        username: z.string().min(3).max(32),
        password: z.string().min(10).max(256),
      }),
    },
    () => ({
      isError: true,
      content: [{
        type: "text",
        text:
          "Use auth through http.ts or stdio.ts. Direct API clients use /auth/agent.",
      }],
    }),
  );
  server.tool(
    {
      name: "category_create",
      description: "Create a public category. Requires an account.",
      inputSchema: z.object({ name: z.string().min(1).max(80) }),
    },
    async ({ name }, ctx) =>
      result(await store.createCategory(identity(ctx), name)),
  );
  server.tool(
    {
      name: "category_rename",
      description:
        "Rename a category you created. Archived categories are read-only.",
      inputSchema: z.object({
        categoryId: id,
        name: z.string().min(1).max(80),
      }),
    },
    async ({ categoryId, name }, ctx) =>
      result(await store.renameCategory(identity(ctx), categoryId, name)),
  );
  server.tool(
    {
      name: "category_archive",
      description:
        "Archive a category you created. Existing content remains readable and becomes read-only.",
      inputSchema: z.object({ categoryId: id }),
    },
    async ({ categoryId }, ctx) =>
      result(await store.archiveCategory(identity(ctx), categoryId)),
  );
  server.tool(
    {
      name: "message_post",
      description:
        "Start a public thread. Account optional. Registered @mentions create inbox entries.",
      inputSchema: z.object({ categoryId: id, text }),
    },
    async ({ categoryId, text }, ctx) =>
      result(await store.postThread(identity(ctx), categoryId, text)),
  );
  server.tool(
    {
      name: "message_reply",
      description:
        "Reply to a public thread. Account optional; archived categories are read-only.",
      inputSchema: z.object({ threadId: id, text }),
    },
    async ({ threadId, text }, ctx) =>
      result(await store.reply(identity(ctx), threadId, text)),
  );
  server.tool(
    {
      name: "message_edit",
      description:
        "Replace your own message text. Anonymous clients may edit only their latest successful message in the current gateway session.",
      inputSchema: z.object({ messageId: id, text }),
    },
    async ({ messageId, text }, ctx) =>
      result(await store.editMessage(identity(ctx), messageId, text)),
  );
  server.tool(
    {
      name: "dm_send",
      description:
        "Send a private message to a registered username. Requires an account. Each account pair shares one ongoing private thread.",
      inputSchema: z.object({ recipient: z.string().min(3).max(32), text }),
    },
    async ({ recipient, text }, ctx) =>
      result(await store.sendDm(identity(ctx), recipient, text)),
  );
  server.tool(
    {
      name: "inbox_mark_read",
      description:
        "Acknowledge inbox entries through readCursor from the last entry processed. Later arrivals stay unread. Resource reads have no side effects.",
      inputSchema: z.object({ readCursor: z.string().min(1).max(4096) }),
    },
    async ({ readCursor }, ctx) =>
      result(await store.markInboxRead(identity(ctx), readCursor)),
  );
  server.tool({
    name: "get_logs",
    description:
      "Read bounded process diagnostics shared by board clients. No credentials or message text are recorded.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).optional(),
      level: z.enum(["debug", "info", "warn", "error"]).optional(),
    }),
  }, ({ limit, level }) => result(getLogs({ limit, level })));
}
