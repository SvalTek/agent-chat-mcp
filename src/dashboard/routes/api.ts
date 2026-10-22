import { Hono } from "hono";
import { z } from "zod";
import type { AdminServices } from "../../admin/service.ts";
import { AdminError, required } from "../../admin/errors.ts";
import { type Query, records } from "../../admin/query.ts";
import { readSettings } from "../../domain/settings.ts";
import { recordLog } from "../../infra/logs.ts";
import {
  type AccessTokenRecord,
  issueAccessToken,
} from "../../auth/access-tokens.ts";
import {
  clearOwnerCookie,
  type DashboardEnv,
  ownerCookie,
  requireOwner,
} from "../middleware/auth.ts";
const credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
const query = (url: string): Query => {
  const p = new URL(url).searchParams;
  return {
    cursor: p.get("cursor") ?? undefined,
    limit: p.has("limit")
      ? z.coerce.number().int().min(1).max(100).parse(p.get("limit"))
      : 30,
    q: z.string().max(200).parse(p.get("q") ?? ""),
    kind: p.get("kind") ?? undefined,
    agentId: p.get("agentId") ?? undefined,
    categoryId: p.get("categoryId") ?? undefined,
    status: p.get("status") ?? undefined,
  };
};
export function adminApi(admin: AdminServices) {
  const api = new Hono<DashboardEnv>();
  api.onError((error, c) => {
    if (error instanceof AdminError) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError) {
      return c.json({
        error: error.issues.map((i) => i.path.join(".") + ": " + i.message)
          .join("; "),
      }, 400);
    }
    recordLog("error", "admin-api", error.name);
    return c.json({ error: "The operation could not be completed." }, 500);
  });
  api.post("/auth/login", async (c) => {
    const input = credentials.parse(await c.req.json());
    const session = await admin.owner.login(input.username, input.password);
    ownerCookie(c, session.token);
    await admin.audit.write("owner.login", "owner", session.username);
    return c.json({ username: session.username, csrf: session.csrf });
  });
  api.use("*", requireOwner(admin.owner, true, admin.integrations));
  const ownerOnly = requireOwner(admin.owner, true);
  api.get(
    "/integrations",
    ownerOnly,
    async (c) => c.json(await admin.integrations.list(query(c.req.url))),
  );
  api.post("/integrations", ownerOnly, async (c) => {
    const input = z.object({
      clientId: z.string().min(3).max(32),
      accessLevel: z.enum(["admin", "user"]),
      expiresIn: z.number().int().min(60).max(31536000).default(2592000),
    }).parse(await c.req.json());
    const result = await admin.integrations.create(
      input.clientId,
      input.accessLevel,
      input.expiresIn,
    );
    await admin.audit.write(
      "integration.created",
      result.record.id,
      c.get("owner").username,
    );
    return c.json(result, 201);
  });
  api.patch("/integrations/:id", ownerOnly, async (c) => {
    const input = z.object({
      accessLevel: z.enum(["admin", "user"]).optional(),
      revoke: z.boolean().optional(),
      rotate: z.boolean().optional(),
    }).parse(await c.req.json());
    const result = await admin.integrations.update(c.req.param("id"), input);
    await admin.audit.write(
      input.revoke ? "integration.revoked" : "integration.updated",
      result.record.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/integrations/:id", ownerOnly, async (c) => {
    const record = required(
      (await admin.store.kv.get<{
        accountId: string;
        expiresAt: string;
        id: string;
        revokedAt: string | null;
      }>(["integration", c.req.param("id")])).value,
      "Integration not found.",
    );
    if (
      !record.revokedAt && Date.parse(record.expiresAt) > Date.now()
    ) throw new AdminError("Revoke the integration before deleting it.", 409);
    const account = await admin.store.getAccount(record.accountId);
    if (account && !account.suspendedAt) {
      await admin.agents.suspend(record.accountId, true);
    }
    const result = await admin.agents.remove(record.accountId);
    await admin.audit.write(
      "integration.purged",
      record.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.get(
    "/auth/me",
    ownerOnly,
    async (c) =>
      c.json({
        username: c.get("owner").username,
        csrf: c.get("owner").csrf,
        defaultPassword: (await admin.owner.owner()).defaultPassword,
      }),
  );
  api.post("/auth/logout", ownerOnly, async (c) => {
    await admin.owner.logout(c.get("owner"));
    clearOwnerCookie(c);
    return c.json({ loggedOut: true });
  });
  api.post("/auth/password", ownerOnly, async (c) => {
    const input = z.object({
      currentPassword: z.string().min(1).max(256),
      newPassword: z.string().min(10).max(256),
    }).parse(await c.req.json());
    const session = await admin.owner.password(
      c.get("owner"),
      input.currentPassword,
      input.newPassword,
    );
    ownerCookie(c, session.token);
    await admin.audit.write(
      "owner.password_changed",
      "owner",
      c.get("owner").username,
    );
    return c.json({ changed: true, csrf: session.csrf });
  });
  api.get("/overview", async (c) => {
    const [overview, activity] = await Promise.all([
      admin.observe.overview(),
      admin.audit.list({ limit: 6 }),
    ]);
    return c.json({ ...overview, activity: activity.items });
  });
  api.get(
    "/activity",
    async (c) => c.json(await admin.audit.list(query(c.req.url))),
  );
  api.get(
    "/conversations",
    async (c) => c.json(await admin.conversations.list(query(c.req.url))),
  );
  api.get(
    "/conversations/:id",
    async (c) =>
      c.json(
        await admin.conversations.detail(c.req.param("id"), query(c.req.url)),
      ),
  );
  api.patch("/conversations/:id", async (c) => {
    const input = z.object({ title: z.string().min(1).max(120) }).parse(
      await c.req.json(),
    );
    const result = await admin.conversations.update(
      c.req.param("id"),
      input.title,
    );
    await admin.audit.write(
      "conversation.renamed",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/conversations/:id", async (c) => {
    const result = await admin.conversations.remove(c.req.param("id"));
    await admin.audit.write(
      "conversation.purged",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.patch("/conversations/:id/archive", async (c) => {
    const input = z.object({ archived: z.boolean() }).parse(await c.req.json());
    const result = await admin.conversations.archive(
      c.req.param("id"),
      input.archived,
    );
    await admin.audit.write(
      input.archived ? "conversation.archived" : "conversation.reopened",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/messages/:id/purge", async (c) => {
    const result = await admin.conversations.purgeMessage(c.req.param("id"));
    await admin.audit.write(
      "message.purged",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.get(
    "/messages",
    async (c) => c.json(await admin.observe.messages(query(c.req.url))),
  );
  api.patch("/messages/:id", async (c) => {
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(
      await c.req.json(),
    );
    const result = await admin.conversations.editMessage(
      c.req.param("id"),
      input.text,
    );
    await admin.audit.write(
      "message.edited",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/messages/:id", async (c) => {
    const result = await admin.conversations.deleteMessage(c.req.param("id"));
    await admin.audit.write(
      "message.redacted",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.get(
    "/categories",
    async (c) => c.json(await admin.categories.list(query(c.req.url))),
  );
  api.post("/categories", async (c) => {
    const input = z.object({ name: z.string().min(1).max(80) }).parse(
      await c.req.json(),
    );
    const result = await admin.categories.create(input.name);
    await admin.audit.write(
      "category.created",
      result.id,
      c.get("owner").username,
    );
    return c.json(result, 201);
  });
  api.patch("/categories/:id", async (c) => {
    const input = z.object({
      name: z.string().min(1).max(80).optional(),
      archived: z.boolean().optional(),
    }).parse(await c.req.json());
    const result = await admin.categories.update(c.req.param("id"), input);
    await admin.audit.write(
      "category.updated",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/categories/:id", async (c) => {
    const result = await admin.categories.remove(c.req.param("id"));
    await admin.audit.write(
      "category.purged",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.get(
    "/agents",
    async (c) => c.json(await admin.agents.list(query(c.req.url))),
  );
  api.get(
    "/agents/:id",
    async (c) =>
      c.json(await admin.agents.detail(c.req.param("id"), query(c.req.url))),
  );
  api.get(
    "/agents/:id/inbox",
    async (c) =>
      c.json(
        (await admin.agents.detail(c.req.param("id"), query(c.req.url))).inbox,
      ),
  );
  api.patch("/agents/:id/profile", async (c) => {
    const input = z.object({ description: z.string().trim().max(500) }).parse(
      await c.req.json(),
    );
    const result = await admin.agents.updateProfile(
      c.req.param("id"),
      input.description,
    );
    await admin.audit.write(
      "agent.profile_updated",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.patch("/agents/:id", async (c) => {
    const input = z.object({ suspended: z.boolean() }).parse(
      await c.req.json(),
    );
    const result = await admin.agents.suspend(
      c.req.param("id"),
      input.suspended,
    );
    await admin.audit.write(
      input.suspended ? "agent.suspended" : "agent.reactivated",
      result.id,
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.delete("/agents/:id", async (c) => {
    const result = await admin.agents.remove(c.req.param("id"));
    await admin.audit.write(
      "agent.purged",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.post("/agents/:id/password", async (c) => {
    const input = z.object({ password: z.string().min(10).max(256) }).parse(
      await c.req.json(),
    );
    const result = await admin.agents.password(
      c.req.param("id"),
      input.password,
    );
    await admin.audit.write(
      "agent.password_reset",
      c.req.param("id"),
      c.get("owner").username,
    );
    return c.json(result);
  });
  api.get(
    "/sessions",
    async (c) => c.json(await admin.observe.sessions(query(c.req.url))),
  );
  api.delete("/sessions/:id", async (c) => {
    const session = required(
      admin.auth.sessions.get(c.req.param("id")),
      "Session not found.",
    );
    await admin.auth.closeSession(session);
    await admin.audit.write(
      "session.disconnected",
      session.sessionId,
      c.get("owner").username,
    );
    return c.json({ disconnected: true });
  });
  api.get(
    "/access",
    ownerOnly,
    async (c) =>
      c.json(
        await records<AccessTokenRecord>(
          admin.store.kv,
          ["access-token"],
          query(c.req.url),
        ),
      ),
  );
  api.post("/access", ownerOnly, async (c) => {
    const input = z.object({
      label: z.string().min(1).max(80),
      expiresIn: z.number().int().min(60).max(2592000).nullable().default(null),
    }).parse(await c.req.json());
    const result = await issueAccessToken(
      admin.auth,
      input.label,
      input.expiresIn,
    );
    await admin.audit.write(
      "token.issued",
      result.record.id,
      c.get("owner").username,
    );
    return c.json(result, 201);
  });
  api.patch("/access/:id", ownerOnly, async (c) => {
    const entry = await admin.store.kv.get<AccessTokenRecord>([
      "access-token",
      c.req.param("id"),
    ]);
    const record = required(entry.value);
    if (record.revokedAt) {
      throw new AdminError("Token is already revoked.", 409);
    }
    const updated = { ...record, revokedAt: new Date().toISOString() };
    if (
      !(await admin.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Token changed. Retry.", 409);
    for (const session of [...admin.auth.sessions.values()]) {
      if (session.gatewayId === record.id) {
        await admin.auth.closeSession(session);
      }
    }
    await admin.audit.write(
      "token.revoked",
      updated.id,
      c.get("owner").username,
    );
    return c.json(updated);
  });
  api.delete("/access/:id", ownerOnly, async (c) => {
    const entry = await admin.store.kv.get<AccessTokenRecord>([
      "access-token",
      c.req.param("id"),
    ]);
    const record = required(entry.value);
    if (
      record.kind !== "api" &&
      !record.revokedAt &&
      (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())
    ) {
      throw new AdminError(
        "Revoke or let the token expire before deleting it.",
        409,
      );
    }
    if (
      !(await admin.store.kv.atomic().check(entry).delete(entry.key).commit())
        .ok
    ) {
      throw new AdminError("Token changed. Retry.", 409);
    }
    await admin.audit.write(
      "token.purged",
      record.id,
      c.get("owner").username,
    );
    return c.json({ deleted: true });
  });
  api.get(
    "/logs",
    (c) =>
      c.json({
        items: admin.observe.logs(
          new URL(c.req.url).searchParams.get("level") ?? undefined,
        ),
      }),
  );
  api.get("/settings", async (c) => c.json(await readSettings(admin.store.kv)));
  api.patch("/settings", async (c) => {
    const input = z.object({
      boardName: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(300).optional(),
      registrationEnabled: z.boolean().optional(),
      anonymousPostingEnabled: z.boolean().optional(),
    }).parse(await c.req.json());
    const result = { ...await readSettings(admin.store.kv), ...input };
    await admin.store.kv.set(["board-settings"], result);
    await admin.audit.write(
      "settings.updated",
      "board",
      c.get("owner").username,
    );
    return c.json(result);
  });
  return api;
}
