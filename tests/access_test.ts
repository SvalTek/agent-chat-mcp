import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { createApp } from "../src/app.ts";

Deno.test("Hono access boundaries distinguish gateway, board and scoped API tokens", async () => {
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
    const gateway = await auth.issue("agent-chat-gateway", "remote", {
      kind: "gateway",
    });
    const anonymous = await auth.openSession(gateway),
      principal = await auth.verifyAgent(anonymous.accessToken);
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
      200,
    );
    const noScope = await auth.issue("agent-chat-api", "external", {
      kind: "api",
    });
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + noScope },
        }),
      )).status,
      403,
    );
    assertEquals(
      (await json(
        await request("/api/v1/categories", {
          headers: { authorization: "Bearer " + foreign },
        }),
      )).status,
      401,
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
      404,
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
