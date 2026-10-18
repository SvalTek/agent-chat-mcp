import { assert, assertEquals } from "@std/assert";
import { MCPClient } from "@mcp-use/client";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { createApp } from "../src/app.ts";

Deno.test({
  name:
    "portable stdio gateway works outside the project without a config or local imports",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "agent-chat-stdio-" });
    const store = await BoardStore.open(join(dir, "board.kv"));
    const auth = new AuthService(store, {
      secret: "stdio-integration-secret-at-least-32-characters",
    });
    const service = createApp({ store, auth });
    const http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      service.app.fetch,
    );
    const gatewayPath = join(dir, "stdio.ts");
    await Deno.copyFile(new URL("../stdio.ts", import.meta.url), gatewayPath);
    const client = MCPClient.fromDict({
      mcpServers: {
        board: {
          command: "deno",
          args: [
            "run",
            "--no-config",
            "--allow-net",
            "--allow-env",
            gatewayPath,
            "--server",
            "http://127.0.0.1:" + http.addr.port,
          ],
          cwd: dir,
          stderr: "inherit",
          protocolNegotiation: "legacy",
        },
      },
    });
    try {
      const connection = await client.connect("board");
      assert((await connection.listTools()).some((t) => t.name === "auth"));
      const result = await connection.callTool("auth", {
        username: "stdio_agent",
        password: "portable gateway password",
      });
      assert(!result.isError);
      assert(!JSON.stringify(result).includes("accessToken"));
      const category = await connection.callTool("category_create", {
        name: "Stdio check",
      });
      assert(!category.isError);
      const resource = await connection.readResource("agent-chat://categories");
      assert(JSON.stringify(resource).includes("Stdio check"));
      const events: string[] = [];
      connection.on("notification", (n) => {
        if (n.method === "notifications/resources/updated") {
          events.push(String(n.params?.uri));
        }
      });
      await connection.subscribeToResource("agent-chat://categories");
      const token = await auth.openSession(),
        principal = await auth.verifyAgent(token.accessToken);
      const identity = auth.identity(principal);
      await store.authenticate(
        identity,
        "another_agent",
        "portable gateway password",
      );
      await store.createCategory(identity, "An update");
      const end = Date.now() + 5000;
      while (!events.length && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(events[0], "agent-chat://categories");
    } finally {
      await client.close();
      await service.close();
      await http.shutdown();
      store.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
