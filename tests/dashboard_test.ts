import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { type AuthOptions, AuthService } from "../src/auth/service.ts";
import { Integrations } from "../src/auth/integrations.ts";
import { createApp } from "../src/app.ts";
const password = "agent testing password";
async function setup(authOptions: Partial<AuthOptions> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "agent-chat-dashboard-" });
  const store = await BoardStore.open(join(dir, "board.kv"));
  const auth = new AuthService(store, {
    secret: "dashboard-test-secret-longer-than-32-characters",
    ...authOptions,
  });
  const app = createApp({ store, auth });
  const request = (path: string, init: RequestInit = {}) =>
    app.app.request("http://localhost" + path, init);
  let cookie = "", csrf = "";
  async function ownerLogin(pwd = "change-me") {
    const response = await request("/api/admin/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: pwd }),
    });
    const body = await response.json();
    if (response.ok) {
      cookie = response.headers.get("set-cookie")!.split(";")[0];
      csrf = body.csrf;
    }
    return { response, body };
  }
  async function ownerApi(path: string, method = "GET", body?: unknown) {
    const response = await request("/api/admin/v1" + path, {
      method,
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (result.csrf) {
      csrf = result.csrf;
      if (response.headers.has("set-cookie")) {
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      }
    }
    return { response, body: result };
  }
  return {
    store,
    auth,
    request,
    ownerLogin,
    ownerApi,
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
    async close() {
      await app.close();
      store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
Deno.test("owner pages redirect, APIs use 401, CSRF is enforced, and default password changes persist", async () => {
  const s = await setup();
  try {
    const page = await s.request("/conversations?q=hello");
    assertEquals(page.status, 303);
    assert(page.headers.get("location")?.startsWith("/login?returnTo="));
    await page.text();
    const unauthorized = await s.request("/api/admin/v1/overview");
    assertEquals(unauthorized.status, 401);
    assertEquals(unauthorized.headers.get("location"), null);
    await unauthorized.text();
    const login = await s.ownerLogin();
    assertEquals(login.response.status, 200);
    assert(login.response.headers.get("set-cookie")?.includes("HttpOnly"));
    assert(
      login.response.headers.get("set-cookie")?.includes("SameSite=Strict"),
    );
    const overview = await s.request("/", { headers: { cookie: s.cookie } });
    assertEquals(overview.status, 200);
    const html = await overview.text();
    assert(html.includes('data-theme="night"'));
    assert(html.includes("drawer-side"));
    assert(html.includes("default owner password"));
    const missingCsrf = await s.request("/api/admin/v1/categories", {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Unsafe" }),
    });
    assertEquals(missingCsrf.status, 403);
    await missingCsrf.text();
    const oldCookie = s.cookie;
    const changed = await s.ownerApi("/auth/password", "POST", {
      currentPassword: "change-me",
      newPassword: "new owner password!",
    });
    assertEquals(changed.response.status, 200);
    const old = await s.request("/api/admin/v1/overview", {
      headers: { cookie: oldCookie },
    });
    assertEquals(old.status, 401);
    await old.text();
    assertEquals((await s.ownerLogin()).response.status, 401);
    assertEquals(
      (await s.ownerLogin("new owner password!")).response.status,
      200,
    );
    const stored =
      (await s.store.kv.get<{ passwordHash: string; defaultPassword: boolean }>(
        ["owner"],
      )).value!;
    assert(!stored.defaultPassword);
    assert(!JSON.stringify(stored).includes("new owner password!"));
    const missing = await s.request("/conversations/unknown", {
      headers: { cookie: s.cookie },
    });
    assertEquals(missing.status, 404);
    assertEquals(missing.headers.get("location"), null);
    await missing.text();
    const asset = await s.request("/assets/dashboard.css");
    assertEquals(asset.status, 200);
    assert((await asset.text()).includes(".drawer"));
  } finally {
    await s.close();
  }
});
Deno.test("owner observes DMs, moderates messages, manages accounts/settings and revokes gateway tokens", async () => {
  const s = await setup();
  try {
    const a = { id: "a", accountId: null, lastMessageId: null },
      b = { id: "b", accountId: null, lastMessageId: null };
    await s.store.authenticate(a, "alice_owner_test", password);
    await s.store.authenticate(b, "bob_owner_test", password);
    const dm = await s.store.sendDm(
      a,
      "bob_owner_test",
      "Private agent coordination",
    );
    await s.ownerLogin();
    const view = await s.ownerApi("/conversations/" + dm.threadId);
    assertEquals(view.response.status, 200);
    assertEquals(
      view.body.messages.items[0].text,
      "Private agent coordination",
    );
    const page = await s.request("/conversations/" + dm.threadId, {
      headers: { cookie: s.cookie },
    });
    assertEquals(page.status, 200);
    assert((await page.text()).includes("Private agent coordination"));
    assertEquals(
      (await s.ownerApi("/messages/" + dm.message.id, "PATCH", {
        text: "Owner correction",
      })).response.status,
      200,
    );
    assertEquals(
      (await s.store.listMessages(b, dm.threadId)).items[0].text,
      "Owner correction",
    );
    assertEquals(
      (await s.ownerApi("/messages/" + dm.message.id, "DELETE")).response
        .status,
      200,
    );
    assertEquals((await s.store.listMessages(b, dm.threadId)).items.length, 0);
    await s.ownerApi("/agents/" + b.accountId, "PATCH", { suspended: true });
    await assertRejects(() =>
      s.store.authenticate(
        { id: "fresh", accountId: null, lastMessageId: null },
        "bob_owner_test",
        password,
      )
    );
    await s.ownerApi("/agents/" + b.accountId, "PATCH", { suspended: false });
    await s.ownerApi("/agents/" + b.accountId + "/password", "POST", {
      password: "replacement agent password",
    });
    await assertRejects(() =>
      s.store.authenticate(
        { id: "fresh", accountId: null, lastMessageId: null },
        "bob_owner_test",
        password,
      )
    );
    await s.store.authenticate(
      { id: "fresh", accountId: null, lastMessageId: null },
      "bob_owner_test",
      "replacement agent password",
    );
    const category =
      (await s.ownerApi("/categories", "POST", { name: "Owner category" }))
        .body;
    await s.ownerApi("/settings", "PATCH", {
      registrationEnabled: false,
      anonymousPostingEnabled: false,
    });
    await assertRejects(() =>
      s.store.authenticate(
        { id: "new", accountId: null, lastMessageId: null },
        "cannot_register",
        password,
      )
    );
    await assertRejects(() =>
      s.store.postThread(
        { id: "anon", accountId: null, lastMessageId: null },
        category.id,
        "Blocked",
      )
    );
    const token = (await s.ownerApi("/access", "POST", {
      label: "Integration test gateway",
    })).body;
    assertEquals(token.record.expiresAt, null);
    assert(await s.auth.verifyPurpose(token.token, "agent-chat-gateway"));
    const finite = (await s.ownerApi("/access", "POST", {
      label: "Finite gateway",
      expiresIn: 60,
    })).body;
    const finiteExpiry = Date.parse(finite.record.expiresAt!),
      finiteBound = Date.now() + 60_000;
    assert(
      finiteExpiry > Date.now() && finiteExpiry <= finiteBound,
      "a finite gateway token must expire about 60 seconds from now",
    );
    await s.ownerApi("/access/" + token.record.id, "DELETE");
    await assertRejects(() =>
      s.auth.verifyPurpose(token.token, "agent-chat-gateway")
    );
  } finally {
    await s.close();
  }
});
Deno.test("integration clientId is stable, user/admin access differs, and role changes, rotation and revocation invalidate credentials", async () => {
  const s = await setup();
  try {
    await s.ownerLogin();
    const userResult = await s.ownerApi("/integrations", "POST", {
      clientId: "ci_agent",
      accessLevel: "user",
    });
    assertEquals(userResult.response.status, 201);
    const user = userResult.body,
      basic = "Basic " + btoa(user.clientId + ":" + user.token);
    assert(!JSON.stringify(user.record).includes("tokenHash"));
    const listing = await s.ownerApi("/integrations");
    assert(!JSON.stringify(listing.body).includes(user.token));
    const exchange = await s.request("/auth/integration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: user.clientId, token: user.token }),
    });
    const jwt = await exchange.json();
    assertEquals(exchange.status, 200);
    const principal = await s.auth.verifyAgent(jwt.accessToken);
    assertEquals(principal.username, "ci_agent");
    const same = await new Integrations(s.auth).exchange(
      "CI_AGENT",
      user.token,
    );
    assertEquals(
      (await s.auth.verifyAgent(same.accessToken)).accountId,
      principal.accountId,
    );
    const categoryResponse = await s.request("/api/v1/categories", {
      method: "POST",
      headers: { authorization: basic, "content-type": "application/json" },
      body: JSON.stringify({ name: "CI work" }),
    });
    assertEquals(categoryResponse.status, 201);
    const category = await categoryResponse.json();
    assertEquals(category.creatorAccountId, principal.accountId);
    const adminDenied = await s.request("/api/admin/v1/overview", {
      headers: { authorization: basic },
    });
    assertEquals(adminDenied.status, 403);
    await adminDenied.text();
    const outsider = { id: "other", accountId: null, lastMessageId: null };
    await s.store.authenticate(outsider, "outsider_agent", password);
    const dm = await s.store.sendDm(
      outsider,
      "ci_agent",
      "Integration private inbox",
    );
    const inbox = await s.request("/api/v1/inbox", {
      headers: { authorization: "Bearer " + jwt.accessToken },
    });
    assertEquals(inbox.status, 200);
    assert(
      JSON.stringify(await inbox.json()).includes("Integration private inbox"),
    );
    const adminResult = (await s.ownerApi("/integrations", "POST", {
      clientId: "operator_bot",
      accessLevel: "admin",
    })).body;
    const adminBasic = "Basic " +
      btoa(adminResult.clientId + ":" + adminResult.token);
    const issued = (await s.ownerApi("/access", "POST", {
      label: "Owner-only probe",
    })).body;
    const escalation = [
      await s.request("/api/admin/v1/integrations", {
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/integrations", {
        method: "POST",
        headers: {
          authorization: adminBasic,
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientId: "escalation", accessLevel: "admin" }),
      }),
      await s.request("/api/admin/v1/integrations/" + adminResult.record.id, {
        method: "PATCH",
        headers: {
          authorization: adminBasic,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accessLevel: "admin" }),
      }),
      await s.request("/api/admin/v1/integrations/" + user.record.id, {
        method: "DELETE",
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/access", {
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/access", {
        method: "POST",
        headers: {
          authorization: adminBasic,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "escalation" }),
      }),
      await s.request("/api/admin/v1/access/" + issued.record.id, {
        method: "DELETE",
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/auth/me", {
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/auth/logout", {
        method: "POST",
        headers: { authorization: adminBasic },
      }),
      await s.request("/api/admin/v1/auth/password", {
        method: "POST",
        headers: {
          authorization: adminBasic,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "irrelevant",
          newPassword: "irrelevant password",
        }),
      }),
    ];
    for (const response of escalation) {
      assertEquals(response.status, 401);
      await response.text();
    }
    // The rejected attempts must not have changed any credential.
    assertEquals(
      (await s.auth.verifyPurpose(issued.token, "agent-chat-gateway")).aud,
      "agent-chat-gateway",
    );
    const stillAdmin = await s.request("/api/admin/v1/overview", {
      headers: { authorization: adminBasic },
    });
    assertEquals(stillAdmin.status, 200);
    await stillAdmin.text();
    assertEquals((await s.ownerApi("/integrations")).response.status, 200);
    const inspected = await s.request(
      "/api/admin/v1/conversations/" + dm.threadId,
      { headers: { authorization: adminBasic } },
    );
    assertEquals(inspected.status, 200);
    assert(
      JSON.stringify(await inspected.json()).includes(
        "Integration private inbox",
      ),
    );
    await s.ownerApi("/integrations/" + user.record.id, "PATCH", {
      accessLevel: "admin",
    });
    await assertRejects(() => s.auth.verifyAgent(jwt.accessToken));
    const upgraded = await s.request("/api/admin/v1/overview", {
      headers: { authorization: basic },
    });
    assertEquals(upgraded.status, 200);
    await upgraded.text();
    const rotated =
      (await s.ownerApi("/integrations/" + user.record.id, "PATCH", {
        rotate: true,
      })).body;
    await assertRejects(() =>
      new Integrations(s.auth).credentials("ci_agent", user.token)
    );
    assertEquals(
      (await new Integrations(s.auth).credentials("ci_agent", rotated.token))
        .accountId,
      principal.accountId,
    );
    await s.ownerApi("/integrations/" + user.record.id, "DELETE");
    await assertRejects(() =>
      new Integrations(s.auth).credentials("ci_agent", rotated.token)
    );
    const revoked = await s.request("/api/v1/categories", {
      headers: { authorization: "Basic " + btoa("ci_agent:" + rotated.token) },
    });
    assertEquals(revoked.status, 401);
    await revoked.text();
  } finally {
    await s.close();
  }
});
Deno.test("revoking a gateway token disconnects only the sessions it opened", async () => {
  const s = await setup({ requireGateway: true });
  try {
    await s.ownerLogin();
    const first = (await s.ownerApi("/access", "POST", {
      label: "Revoked gateway",
    })).body;
    const second = (await s.ownerApi("/access", "POST", {
      label: "Live gateway",
    })).body;
    const revokedSession = await s.auth.openSession(first.token),
      liveSession = await s.auth.openSession(second.token);
    assertEquals(
      (await s.auth.verifyAgent(revokedSession.accessToken)).gatewayId,
      first.record.id,
    );
    assertEquals(
      (await s.auth.verifyAgent(liveSession.accessToken)).gatewayId,
      second.record.id,
    );
    assertEquals(
      (await s.ownerApi("/access/" + first.record.id, "DELETE")).response
        .status,
      200,
    );
    await assertRejects(() => s.auth.verifyAgent(revokedSession.accessToken));
    assertEquals(
      (await s.auth.verifyAgent(liveSession.accessToken)).sessionId,
      liveSession.sessionId,
    );
    assertEquals(
      [...s.auth.sessions.values()].filter((p) =>
        p.gatewayId === first.record.id
      ).length,
      0,
      "a revoked token must own no live sessions",
    );
    await assertRejects(() => s.auth.openSession(first.token));
  } finally {
    await s.close();
  }
});
