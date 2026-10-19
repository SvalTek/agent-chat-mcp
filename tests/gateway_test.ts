import { assert, assertEquals, assertRejects } from "@std/assert";
import { MCPClient } from "@mcp-use/client";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { createApp } from "../src/app.ts";
import type { createHttpGateway as GatewayFactory } from "../src/gateway/http.ts";

function value(result: { content?: unknown }) {
  const content = result.content as { type: string; text?: string }[];
  return JSON.parse(content.find((c) => c.type === "text")!.text!);
}
/** Joins the text blocks of a resource result, ignoring binary blocks. */
function resourceText(result: { contents: unknown }) {
  const contents = Array.isArray(result.contents) ? result.contents : [];
  return contents.map((content) =>
    content && typeof content === "object" && "text" in content &&
      typeof content.text === "string"
      ? content.text
      : ""
  ).join("");
}
const password = "correct horse battery staple";
Deno.test({
  name:
    "HTTP gateway: modern upstream, isolated identities, cursor resources, notifications and reauthentication",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "agent-chat-integration-" });
    const store = await BoardStore.open(join(dir, "board.kv"));
    const auth = new AuthService(store, {
      secret: "integration-secret-at-least-32-characters",
    });
    let backend = createApp({ store, auth });
    const http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => backend.app.fetch(request),
    );
    const url = "http://127.0.0.1:" + http.addr.port;
    const copiedHttp = join(dir, "http.ts");
    await Deno.copyFile(new URL("../http.ts", import.meta.url), copiedHttp);
    const { createHttpGateway } = await import(
      pathToFileURL(copiedHttp).href
    ) as { createHttpGateway: typeof GatewayFactory };
    const gateway = createHttpGateway({ url });
    const gatewayHttp = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    }, gateway.app.fetch);
    const makeClient = (legacy = true) =>
      MCPClient.fromDict({
        mcpServers: {
          board: {
            url: "http://127.0.0.1:" + gatewayHttp.addr.port + "/mcp",
            oauth: false,
            ...(legacy ? { protocolNegotiation: "legacy" as const } : {}),
          },
        },
      });
    const a = makeClient(), b = makeClient(false);
    try {
      const alice = await a.connect("board"), bob = await b.connect("board");
      assert((await alice.listTools()).some((t) => t.name === "auth"));
      // The bundled skill is served from disk, as markdown, and documents the views.
      const skill =
        (await alice.readResource("agent-chat://skill")).contents[0];
      assert(
        "text" in skill && skill.text.includes("agent-chat://inbox/me") &&
          skill.text.length > 500,
      );
      // The directory is readable without an identity, and empty before anyone registers.
      assertEquals(
        JSON.parse(
          resourceText(await alice.readResource("agent-chat://agents")),
        )
          .items.length,
        0,
      );
      const status = await alice.callTool("auth", {
        username: "alice",
        password,
      });
      assert(!JSON.stringify(status).includes("accessToken"));
      assert(value(status).authenticated);
      assertEquals(
        value(
          await alice.callTool("profile_update", {
            description: "Coordinates the release train.",
          }),
        ).description,
        "Coordinates the release train.",
      );
      const directory = JSON.parse(
        resourceText(await alice.readResource("agent-chat://agents")),
      );
      assertEquals(
        directory.items.map((item: { username: string }) => item.username),
        ["alice"],
      );
      assertEquals(
        directory.items[0].description,
        "Coordinates the release train.",
      );
      assertEquals(
        JSON.parse(
          resourceText(
            await bob.readResource(
              "agent-chat://agents/" + directory.items[0].id,
            ),
          ),
        ).description,
        "Coordinates the release train.",
        "any client can read a listed profile",
      );
      const category = value(
        await alice.callTool("category_create", { name: "Coordination" }),
      );
      assert(
        (await bob.callTool("category_create", { name: "Forbidden" })).isError,
      );
      await bob.callTool("auth", { username: "bob", password });
      const category2 = value(
        await bob.callTool("category_create", { name: "Second" }),
      );
      assert(category.id !== category2.id);
      const page = await alice.readResource("agent-chat://categories?limit=1");
      const parsed = JSON.parse(resourceText(page));
      assertEquals(parsed.items.length, 1);
      assert(parsed.nextCursor);
      const next = await alice.readResource(
        "agent-chat://categories?limit=1&cursor=" +
          encodeURIComponent(parsed.nextCursor),
      );
      assertEquals(JSON.parse(resourceText(next)).items.length, 1);

      // One idempotency key may cover one write per tool: retries replay, tools stay distinct.
      const posted = value(
        await alice.callTool("message_post", {
          categoryId: category.id,
          text: "Idempotent post",
          idempotencyKey: "gateway-retry-1",
        }),
      );
      const reposted = value(
        await alice.callTool("message_post", {
          categoryId: category.id,
          text: "Idempotent post",
          idempotencyKey: "gateway-retry-1",
        }),
      );
      assertEquals(reposted.message.id, posted.message.id);
      const replied = value(
        await alice.callTool("message_reply", {
          threadId: posted.thread.id,
          text: "Idempotent reply",
          idempotencyKey: "gateway-retry-1",
        }),
      );
      const replayedReply = value(
        await alice.callTool("message_reply", {
          threadId: posted.thread.id,
          text: "Idempotent reply",
          idempotencyKey: "gateway-retry-1",
        }),
      );
      assertEquals(replayedReply.id, replied.id);
      assertEquals(
        JSON.parse(
          resourceText(
            await alice.readResource(
              "agent-chat://threads/" + posted.thread.id,
            ),
          ),
        ).items.length,
        2,
      );
      // Posting followed the thread; the follow tools round-trip through the adapter.
      assertEquals(
        value(
          await alice.callTool("thread_follow", {
            threadId: posted.thread.id,
          }),
        ).following,
        true,
      );
      assertEquals(
        value(
          await alice.callTool("thread_unfollow", {
            threadId: posted.thread.id,
          }),
        ).following,
        false,
      );
      // Search is unaffected by the follow state; the second category stays out of scope.
      const searched = value(
        await alice.callTool("board_search", {
          query: "idempotent",
          categoryId: category.id,
        }),
      );
      assertEquals(
        searched.items.map((item: { message: { text: string } }) =>
          item.message.text
        ),
        ["Idempotent reply", "Idempotent post"],
      );
      assertEquals(searched.scanned, 2);
      assertEquals(searched.truncated, false);

      const updates: string[] = [];
      bob.on("notification", (event) => {
        if (event.method === "notifications/resources/updated") {
          updates.push(String(event.params?.uri));
        }
      });
      await bob.subscribeToResource("agent-chat://inbox/me");
      const dm = value(
        await alice.callTool("dm_send", {
          recipient: "bob",
          text: "Private hello",
        }),
      );
      await until(() => updates.includes("agent-chat://inbox/me"));
      assert(
        JSON.stringify(
          await bob.readResource("agent-chat://dms/" + dm.threadId),
        ).includes("Private hello"),
      );
      const inbox = JSON.parse(
        (await bob.readResource("agent-chat://inbox/me")).contents.map((c) =>
          "text" in c ? c.text : ""
        ).join(""),
      );
      assertEquals(inbox.items.length, 1);
      updates.length = 0;
      await backend.close();
      backend = createApp({ store, auth });
      // Reconnection re-establishes subscriptions and prompts a durable reread.
      await until(() => updates.includes("agent-chat://inbox/me"));
      assert(
        JSON.stringify(await bob.readResource("agent-chat://inbox/me"))
          .includes("Private hello"),
      );
      updates.length = 0;
      await alice.callTool("dm_send", {
        recipient: "bob",
        text: "After reconnect",
      });
      await until(() => updates.includes("agent-chat://inbox/me"));
      const failed = await bob.callTool("auth", {
        username: "alice",
        password: "wrong password",
      });
      assert(failed.isError);
      assert(
        JSON.stringify(await bob.readResource("agent-chat://inbox/me"))
          .includes("Private hello"),
      );
      await bob.callTool("auth", { username: "charlie", password });
      await assertRejects(() =>
        bob.readResource("agent-chat://dms/" + dm.threadId)
      );
      updates.length = 0;
      await alice.callTool("dm_send", { recipient: "bob", text: "Only Bob" });
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(updates.length, 0);

      // The new public views are subscribable, and the writes that change them
      // signal their subscribers.
      await bob.subscribeToResource("agent-chat://feed");
      updates.length = 0;
      await alice.callTool("message_post", {
        categoryId: category.id,
        text: "Feed subscriber ping",
      });
      await until(() => updates.includes("agent-chat://feed"));
      await bob.subscribeToResource("agent-chat://agents");
      updates.length = 0;
      await alice.callTool("profile_update", {
        description: "Pinging the directory",
      });
      await until(() => updates.includes("agent-chat://agents"));
      const anonymous = await auth.openSession();
      const p = await auth.verifyAgent(anonymous.accessToken);
      const refreshed = await auth.refresh(p);
      assertEquals(
        (await auth.verifyAgent(refreshed.accessToken)).sessionId,
        p.sessionId,
      );
      const changed = await auth.authenticate(p, "david", password);
      const modern = MCPClient.fromDict({
        mcpServers: {
          direct: {
            url: url + "/mcp",
            authToken: changed.accessToken,
            oauth: false,
            protocolNegotiation: { pin: "2026-07-28" },
          },
        },
      });
      try {
        const connection = await modern.connect("direct");
        assertEquals(connection.info.protocolVersion, "2026-07-28");
        assert(
          JSON.stringify(
            await connection.readResource("agent-chat://categories"),
          ).includes("Coordination"),
        );
      } finally {
        await modern.close();
      }
      await assertRejects(() => auth.verifyAgent(anonymous.accessToken));
      await assertRejects(() =>
        auth.verifyPurpose(changed.accessToken, "unrelated-service")
      );
      const foreign = await auth.issue("unrelated-service", "external", {
        kind: "external",
      });
      await assertRejects(() => auth.verifyAgent(foreign));
      const expired = await auth.issue("agent-chat-mcp", p.sessionId, {
        sid: p.sessionId,
        rev: p.revision,
      }, -10);
      await assertRejects(() => auth.verifyAgent(expired));
      const alien = new AuthService(store, {
        secret: "different-integration-secret-at-least-32-characters",
      });
      await assertRejects(() =>
        alien.verifyPurpose(changed.accessToken, "agent-chat-mcp")
      );
    } finally {
      await a.close();
      await b.close();
      await gateway.close();
      await gatewayHttp.shutdown();
      await backend.close();
      await http.shutdown();
      store.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error("Timed out waiting for resource update.");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
