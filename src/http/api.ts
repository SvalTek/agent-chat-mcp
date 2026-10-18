import { Hono } from "hono";
import { z } from "zod";
import { type AgentPrincipal, AuthService, bearer } from "../auth/service.ts";
import { Integrations } from "../auth/integrations.ts";
import type { BoardStore } from "../domain/board.ts";
import { pageOptions } from "./query.ts";
import { recordLog } from "../infra/logs.ts";
const credentials = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(10).max(256),
});
type ApiEnv = { Variables: { principal: AgentPrincipal | null } };
export function createApi(
  store: BoardStore,
  auth: AuthService,
  integrations = new Integrations(auth),
) {
  const app = new Hono<ApiEnv>();
  app.post("/auth/session", async (c) => {
    try {
      return c.json(
        await auth.openSession(
          c.req.header("authorization")?.replace(/^Bearer /, ""),
        ),
      );
    } catch {
      return c.json({ error: "Gateway credential required." }, 401);
    }
  });
  app.post("/auth/agent", async (c) => {
    try {
      const principal = await auth.verifyAgent(bearer(c.req.raw)),
        input = credentials.parse(await c.req.json());
      return c.json(
        await auth.authenticate(principal, input.username, input.password),
      );
    } catch {
      recordLog("warn", "auth", "Agent authentication failed.");
      return c.json({
        error:
          "Invalid credentials or account unavailable. If this name is already registered, use its password or choose another name.",
      }, 401);
    }
  });
  app.post("/auth/integration", async (c) => {
    try {
      const input = z.object({
        clientId: z.string().min(3).max(32),
        token: z.string().min(1).max(256),
      }).parse(await c.req.json());
      return c.json(await integrations.exchange(input.clientId, input.token));
    } catch {
      return c.json({ error: "Invalid integration credentials." }, 401);
    }
  });
  app.post("/auth/refresh", async (c) => {
    try {
      return c.json(
        await auth.refresh(await auth.verifyAgent(bearer(c.req.raw))),
      );
    } catch {
      return c.json({
        error: "Session expired; reconnect and authenticate again.",
      }, 401);
    }
  });
  app.delete("/auth/session", async (c) => {
    try {
      await auth.closeSession(await auth.verifyAgent(bearer(c.req.raw)));
      return c.json({ closed: true });
    } catch {
      return c.json({ error: "Session unavailable." }, 401);
    }
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.use("/api/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    try {
      if (header.startsWith("Basic ")) {
        c.set("principal", (await integrations.request(c.req.raw)).principal);
      } else {
        const token = bearer(c.req.raw);
        try {
          c.set("principal", await auth.verifyAgent(token));
        } catch {
          const claims = await auth.verifyPurpose(token, "agent-chat-api");
          if (
            claims.kind !== "api" ||
            !String(claims.scope ?? "").split(" ").includes("board:read")
          ) return c.json({ error: "board:read scope required." }, 403);
          c.set("principal", null);
        }
      }
    } catch {
      return c.json({ error: "Invalid API credentials." }, 401);
    }
    if (!["GET", "HEAD"].includes(c.req.method) && !c.get("principal")) {
      return c.json({
        error: "User integration credentials required for writes.",
      }, 403);
    }
    await next();
  });
  const identity = (principal: AgentPrincipal | null) =>
    principal
      ? auth.identity(principal)
      : { id: "api", accountId: null, lastMessageId: null };
  app.get(
    "/api/v1/categories",
    async (c) =>
      c.json(await store.listCategories(pageOptions(new URL(c.req.url)))),
  );
  app.post("/api/v1/categories", async (c) => {
    const input = z.object({ name: z.string().min(1).max(80) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.createCategory(identity(c.get("principal")), input.name),
      201,
    );
  });
  app.patch("/api/v1/categories/:id", async (c) => {
    const input = z.object({ name: z.string().min(1).max(80) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.renameCategory(
        identity(c.get("principal")),
        c.req.param("id"),
        input.name,
      ),
    );
  });
  app.post(
    "/api/v1/categories/:id/archive",
    async (c) =>
      c.json(
        await store.archiveCategory(
          identity(c.get("principal")),
          c.req.param("id"),
        ),
      ),
  );
  app.get(
    "/api/v1/categories/:id/threads",
    async (c) =>
      c.json(
        await store.listThreads(
          c.req.param("id"),
          pageOptions(new URL(c.req.url)),
        ),
      ),
  );
  app.post("/api/v1/categories/:id/threads", async (c) => {
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.postThread(
        identity(c.get("principal")),
        c.req.param("id"),
        input.text,
      ),
      201,
    );
  });
  app.get("/api/v1/threads/:id", async (c) => {
    const thread = await store.getThread(c.req.param("id"));
    if (!thread || (!c.get("principal") && thread.kind !== "public")) {
      return c.json({ error: "Conversation not found." }, 404);
    }
    return c.json(
      await store.listMessages(
        identity(c.get("principal")),
        thread.id,
        pageOptions(new URL(c.req.url)),
      ),
    );
  });
  app.post("/api/v1/threads/:id/messages", async (c) => {
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.reply(
        identity(c.get("principal")),
        c.req.param("id"),
        input.text,
      ),
      201,
    );
  });
  app.patch("/api/v1/messages/:id", async (c) => {
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.editMessage(
        identity(c.get("principal")),
        c.req.param("id"),
        input.text,
      ),
    );
  });
  app.post("/api/v1/dms", async (c) => {
    const input = z.object({
      recipient: z.string().min(3).max(32),
      text: z.string().min(1).max(20000),
    }).parse(await c.req.json());
    return c.json(
      await store.sendDm(
        identity(c.get("principal")),
        input.recipient,
        input.text,
      ),
      201,
    );
  });
  app.get(
    "/api/v1/inbox",
    async (c) =>
      c.json(
        await store.listInbox(
          identity(c.get("principal")),
          pageOptions(new URL(c.req.url)),
        ),
      ),
  );
  app.post("/api/v1/inbox/read", async (c) => {
    const input = z.object({ readCursor: z.string().min(1).max(4096) }).parse(
      await c.req.json(),
    );
    return c.json(
      await store.markInboxRead(identity(c.get("principal")), input.readCursor),
    );
  });
  return app;
}
