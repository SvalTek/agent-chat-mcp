import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { issueAccessToken } from "../src/auth/access-tokens.ts";
import { createApp } from "../src/app.ts";

Deno.test("Hono access boundaries distinguish gateway and board tokens", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent-chat-access-" });
  const store = await BoardStore.open(join(dir, "board.kv"));
  const auth = new AuthService(store, {
    secret: "access-test-secret-at-least-32-characters",
    requireGateway: true,
  });
  const service = createApp({ store, auth });
  const request = (path: string, options: RequestInit = {}) =>
    service.app.request("http://127.0.0.1" + path, options);
  const json = async (response: Response) => {
    const data = await response.json();
    return { status: response.status, data };
  };
  try {
    assertEquals(
      (await json(await request("/auth/session", { method: "POST" }))).status,
      401,
    );
    const foreign = await auth.issue("unrelated-service", "external", {
      kind: "external",
    });
    await assertRejects(() => auth.openSession(foreign));
    const gateway = await issueAccessToken(auth, "remote");
    assertEquals(gateway.record.expiresAt, null);
    const opened = await json(
      await request("/auth/session", {
        method: "POST",
        headers: { authorization: "Bearer " + gateway.token },
      }),
    );
    assertEquals(opened.status, 200);
    assertEquals(
      (await auth.verifyAgent(opened.data.accessToken)).gatewayId,
      gateway.record.id,
    );
    const anonymous = await auth.openSession(gateway.token),
      principal = await auth.verifyAgent(anonymous.accessToken);
    assertEquals(principal.gatewayId, gateway.record.id);
    assertEquals(
      (await auth.verifyAgent(
        (await auth.refresh(principal, gateway.token)).accessToken,
      )).gatewayId,
      gateway.record.id,
    );
    await assertRejects(() => auth.refresh(principal));
    const other = await issueAccessToken(auth, "other");
    await assertRejects(() => auth.refresh(principal, other.token));
    await store.kv.set(["access-token", gateway.record.id], {
      ...gateway.record,
      revokedAt: new Date().toISOString(),
    });
    await assertRejects(() => auth.refresh(principal, gateway.token));
    await store.kv.set(["access-token", gateway.record.id], gateway.record);
    const refreshed = await json(
      await request("/auth/refresh", {
        method: "POST",
        headers: {
          authorization: "Bearer " + anonymous.accessToken,
          "x-agent-chat-gateway-token": gateway.token,
        },
      }),
    );
    assertEquals(refreshed.status, 200);
    assertEquals(
      (await auth.verifyAgent(refreshed.data.accessToken)).sessionId,
      principal.sessionId,
    );
    assertEquals(
      (await json(
        await request("/auth/refresh", {
          method: "POST",
          headers: { authorization: "Bearer " + anonymous.accessToken },
        }),
      )).status,
      401,
    );
    assertEquals(
      (await json(
        await request("/auth/refresh", {
          method: "POST",
          headers: {
            authorization: "Bearer " + anonymous.accessToken,
            "x-agent-chat-gateway-token": other.token,
          },
        }),
      )).status,
      401,
    );
    await store.kv.set(["access-token", gateway.record.id], {
      ...gateway.record,
      revokedAt: new Date().toISOString(),
    });
    const staleRefresh = await json(
      await request("/auth/refresh", {
        method: "POST",
        headers: {
          authorization: "Bearer " + anonymous.accessToken,
          "x-agent-chat-gateway-token": gateway.token,
        },
      }),
    );
    assertEquals(staleRefresh.status, 401);
    assert(
      String(staleRefresh.data.error).includes("Installation credential"),
      "refresh must report the dead installation credential, not an expired session",
    );
    await store.kv.set(["access-token", gateway.record.id], gateway.record);
    // A revoke landing between the credential check and the session insert
    // must not leave a live session behind.
    const racing = await issueAccessToken(auth, "racing");
    const cleanup = auth.cleanupExpiredSessions.bind(auth);
    auth.cleanupExpiredSessions = async () => {
      await cleanup();
      await store.kv.set(["access-token", racing.record.id], {
        ...racing.record,
        revokedAt: new Date().toISOString(),
      });
    };
    await assertRejects(() => auth.openSession(racing.token));
    assertEquals(
      [...auth.sessions.values()].filter((p) =>
        p.gatewayId === racing.record.id
      ).length,
      0,
      "an openSession that loses the race must not stay in the session map",
    );
    auth.cleanupExpiredSessions = cleanup;
    const account = await auth.authenticate(
      principal,
      "board_owner",
      "board owner password",
    );
    const identity = auth.identity(await auth.verifyAgent(account.accessToken));
    await store.createCategory(identity, "Original");
    const api = await auth.issue("agent-chat-api", "external", {
      kind: "api",
      scope: "board:read",
    });
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + api },
        }),
      )).status,
      401,
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          method: "POST",
          headers: {
            authorization: "Bearer " + api,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Forbidden" }),
        }),
      )).status,
      401,
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + foreign },
        }),
      )).status,
      401,
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + account.accessToken },
        }),
      )).status,
      200,
    );
    const dmUser = { id: "other", accountId: null, lastMessageId: null };
    await store.authenticate(dmUser, "other_account", "other account password");
    const dm = await store.sendDm(identity, "other_account", "Secret");
    assertEquals(
      (await json(
        await request("/api/v1/threads/" + dm.threadId, {
          headers: { authorization: "Bearer " + api },
        }),
      )).status,
      401,
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + gateway.token },
        }),
      )).status,
      401,
    );
    const short = await issueAccessToken(auth, "short", 60);
    const shortExpiry = Date.parse(short.record.expiresAt!),
      shortBound = Date.now() + 60_000;
    assert(
      shortExpiry > Date.now() && shortExpiry <= shortBound,
      "a finite token must expire about 60 seconds from now",
    );
    // The KV record is authoritative: a permanent JWT (no exp) is still
    // rejected once its record expiry has passed, and a session it opened
    // cannot extend itself by re-authenticating.
    const stale = await issueAccessToken(auth, "stale record");
    assertEquals(stale.record.expiresAt, null);
    const staleSession = await auth.openSession(stale.token),
      stalePrincipal = await auth.verifyAgent(staleSession.accessToken);
    await store.kv.set(["access-token", stale.record.id], {
      ...stale.record,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await assertRejects(() =>
      auth.verifyPurpose(stale.token, "agent-chat-gateway")
    );
    await assertRejects(() => auth.openSession(stale.token));
    await assertRejects(() =>
      auth.authenticate(stalePrincipal, "stale_agent", "stale agent password")
    );
    const reinstated = await json(
      await request("/auth/agent", {
        method: "POST",
        headers: {
          authorization: "Bearer " + staleSession.accessToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "stale_agent",
          password: "stale agent password",
        }),
      }),
    );
    assertEquals(reinstated.status, 401);
    assert(
      String(reinstated.data.error).includes("Installation credential"),
      "a lapsed installation credential must be reported, not blamed on the account",
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + staleSession.accessToken },
        }),
      )).status,
      200,
      "the session itself stays usable until its board bearer expires",
    );
    const loopback = new AuthService(store, {
      secret: "loopback-test-secret-at-least-32-characters",
      requireGateway: false,
    });
    const local = await loopback.openSession(),
      localPrincipal = await loopback.verifyAgent(local.accessToken);
    assertEquals(localPrincipal.gatewayId, undefined);
    assertEquals(
      (await loopback.verifyAgent(
        (await loopback.refresh(localPrincipal)).accessToken,
      )).sessionId,
      localPrincipal.sessionId,
    );
    const denied = await request("/health", {
      headers: { origin: "https://untrusted.example" },
    });
    assertEquals(denied.status, 403);
    await denied.text();
  } finally {
    await service.close();
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
