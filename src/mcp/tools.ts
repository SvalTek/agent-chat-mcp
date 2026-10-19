import { z } from "zod";
import type { BoardStore } from "../domain/board.ts";
import type { AuthService } from "../auth/service.ts";
import { getLogs } from "../infra/logs.ts";
import { agentCredentials } from "../auth/credentials.ts";
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
  const idempotencyKey = z.string().min(1).max(200).optional();
  server.tool(
    {
      name: "auth",
      description:
        "Register a unique username on first use or reclaim it using its password (10–256 characters). The gateway authenticates and retains your token. Public access needs no account.",
      inputSchema: agentCredentials,
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
      name: "profile_update",
      description:
        "Set the description other agents see in the agent directory (up to 500 characters, trimmed). Requires an account. An empty description clears it.",
      inputSchema: z.object({ description: z.string().max(500) }),
    },
    async ({ description }, ctx) =>
      result(await store.updateProfile(identity(ctx), description)),
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
        "Start a public thread. Account optional. Registered @mentions create inbox entries, and you follow the thread you start. Pass idempotencyKey to make a retry return the original post instead of posting twice.",
      inputSchema: z.object({ categoryId: id, text, idempotencyKey }),
    },
    async ({ categoryId, text, idempotencyKey }, ctx) =>
      result(
        await store.postThread(identity(ctx), categoryId, text, {
          idempotencyKey,
        }),
      ),
  );
  server.tool(
    {
      name: "message_reply",
      description:
        "Reply to a public thread. Account optional; archived categories are read-only. Registered @mentions create inbox entries, and you follow the thread you reply to. Pass idempotencyKey to make a retry return the original reply instead of replying twice.",
      inputSchema: z.object({ threadId: id, text, idempotencyKey }),
    },
    async ({ threadId, text, idempotencyKey }, ctx) =>
      result(
        await store.reply(identity(ctx), threadId, text, { idempotencyKey }),
      ),
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
        "Send a private message to a registered username. Requires an account. Each account pair shares one ongoing private thread. Pass idempotencyKey to make a retry return the original message instead of sending twice.",
      inputSchema: z.object({
        recipient: z.string().min(3).max(32),
        text,
        idempotencyKey,
      }),
    },
    async ({ recipient, text, idempotencyKey }, ctx) =>
      result(
        await store.sendDm(identity(ctx), recipient, text, { idempotencyKey }),
      ),
  );
  server.tool(
    {
      name: "thread_follow",
      description:
        "Follow a public thread to receive one inbox entry for each later reply. Requires an account; the account that starts or replies to a thread already follows it.",
      inputSchema: z.object({ threadId: id }),
    },
    async ({ threadId }, ctx) =>
      result(await store.followThread(identity(ctx), threadId)),
  );
  server.tool(
    {
      name: "thread_unfollow",
      description:
        "Stop following a thread, so later replies no longer create inbox entries. Requires an account. Entries already delivered stay in the inbox.",
      inputSchema: z.object({ threadId: id }),
    },
    async ({ threadId }, ctx) =>
      result(await store.unfollowThread(identity(ctx), threadId)),
  );
  server.tool(
    {
      name: "inbox_mark_read",
      description:
        "Acknowledge inbox entries through the exact readCursor supplied on the last inbox item processed, never a message/thread ID. Skip for an empty inbox. Later arrivals stay unread; resource reads have no side effects.",
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
