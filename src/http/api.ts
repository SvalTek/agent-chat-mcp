import { Hono } from "hono";
import { z } from "zod";
import {
  type AgentPrincipal,
  AuthService,
  bearer,
  StaleGatewayCredential,
} from "../auth/service.ts";
import { Integrations } from "../auth/integrations.ts";
import type { BoardStore } from "../domain/board.ts";
import { pageOptions } from "./query.ts";
import { recordLog } from "../infra/logs.ts";
import { agentCredentials } from "../auth/credentials.ts";
type ApiEnv = { Variables: { principal: AgentPrincipal } };
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
    let principal: AgentPrincipal;
    try {
      principal = auth.identifyClient(
        await auth.verifyAgent(bearer(c.req.raw)),
        c.req.raw,
      );
    } catch {
      recordLog(
        "warn",
        "auth",
        "Agent authentication rejected: invalid or expired session.",
      );
      return c.json({
        error:
          "Invalid or expired session. Reconnect the gateway before authenticating.",
      }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      recordLog(
        "warn",
        "auth",
        "Agent authentication rejected: invalid JSON.",
        principal,
      );
      return c.json({
        error:
          "Authentication input must be a JSON object with username and password.",
      }, 400);
    }
    const parsed = agentCredentials.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      recordLog(
        "warn",
        "auth",
        "Agent authentication rejected: invalid input fields (" +
          issues.map((i) => i.field || "input").join(", ") + ").",
        principal,
      );
      return c.json(
        { error: issues.map((i) => i.message).join(" "), issues },
        400,
      );
    }
    try {
      const data = await auth.authenticate(
        principal,
        parsed.data.username,
        parsed.data.password,
      );
      recordLog(
        "info",
        "auth",
        data.status.registered
          ? "Agent account registered."
          : "Agent authenticated.",
        auth.sessions.get(principal.sessionId),
      );
      return c.json(data);
    } catch (error) {
      if (error instanceof StaleGatewayCredential) {
        recordLog(
          "warn",
          "auth",
          "Agent authentication rejected: installation credential expired or revoked.",
          principal,
        );
        return c.json({
          error:
            "Installation credential expired or revoked. Reconnect the gateway with a valid token.",
        }, 401);
      }
      recordLog(
        "warn",
        "auth",
        "Agent authentication rejected: credentials or account unavailable.",
        principal,
      );
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
      const principal = await auth.verifyAgent(bearer(c.req.raw));
      return c.json(
        await auth.refresh(
          principal,
          c.req.header("x-agent-chat-gateway-token"),
        ),
      );
    } catch (error) {
      if (error instanceof StaleGatewayCredential) {
        return c.json({
          error:
            "Installation credential required, expired, or revoked. Reconnect the gateway with a valid token.",
        }, 401);
      }
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
        c.set("principal", await auth.verifyAgent(bearer(c.req.raw)));
      }
    } catch {
      return c.json({ error: "Invalid API credentials." }, 401);
    }
    await next();
  });
  const identity = (principal: AgentPrincipal) => auth.identity(principal);
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
    if (!thread) return c.json({ error: "Conversation not found." }, 404);
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
