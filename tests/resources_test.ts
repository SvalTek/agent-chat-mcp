import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { readResource, registerResources } from "../src/mcp/resources.ts";

const password = "correct horse battery staple";

Deno.test("advertised resources are concrete and placeholder URIs are templates", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent-chat-resources-" });
  const store = await BoardStore.open(join(dir, "board.kv"));
  const auth = new AuthService(store, {
    secret: "resource-test-secret-at-least-32-characters",
  });
  const resources: { name: string; uri: string }[] = [];
  const templates: { name: string; uriTemplate: string }[] = [];
  try {
    // A stub MCP surface: the registrations are what this test asserts.
    registerResources(
      {
        resource: (definition: { name: string; uri: string }) =>
          resources.push(definition),
        resourceTemplate: (definition: { name: string; uriTemplate: string }) =>
          templates.push(definition),
      } as never,
      store,
      auth,
    );

    assert(resources.length > 0);
    assert(templates.length > 0);

    // A static resource promises a readable URI. Registering a `{placeholder}`
    // as one advertises a resource that is rejected the moment a host reads it.
    assertEquals(
      resources.filter((entry) => entry.uri.includes("{")),
      [],
      "placeholder URIs belong in the resource templates",
    );
    assertEquals(
      templates.filter((entry) => !entry.uriTemplate.includes("{")),
      [],
      "a template must contain at least one variable",
    );
    for (
      const expected of [
        "agent-chat://categories/{categoryId}/threads{?cursor,limit}",
        "agent-chat://threads/{threadId}{?cursor,limit}",
        "agent-chat://dms/{threadId}{?cursor,limit}",
        "agent-chat://agents/{agentId}",
      ]
    ) {
      assert(
        templates.some((entry) => entry.uriTemplate === expected),
        `missing template ${expected}`,
      );
    }

    // Every concrete resource resolves for an account that may read it, which is
    // the promise a static registration makes.
    const opened = await auth.openSession();
    const authenticated = await auth.authenticate(
      await auth.verifyAgent(opened.accessToken),
      "resources_owner",
      password,
    );
    const principal = await auth.verifyAgent(authenticated.accessToken);
    for (const entry of resources) {
      const result = await readResource(
        store,
        auth,
        principal,
        new URL(entry.uri),
      );
      assert(
        result.contents.length > 0,
        `static resource ${entry.uri} must be readable`,
      );
    }
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
