import { Gateway, type GatewayOptions, optionsFromArgs } from "./client.ts";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@mcp/server";

export function createHttpGateway(options: GatewayOptions = {}) {
  const app = new Hono();
  const sessions = new Map<
    string,
    {
      gateway: Gateway;
      transport: WebStandardStreamableHTTPServerTransport;
      touched: number;
    }
  >();
  app.get(
    "/health",
    (c) => c.json({ status: "ok", activeSessions: sessions.size }),
  );
  app.all("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: "Origin rejected." }, 403);
    }
    const sid = c.req.header("mcp-session-id");
    let session = sid ? sessions.get(sid) : undefined;
    if (sid && !session) {
      return c.json({ error: "Unknown gateway session. Reconnect." }, 404);
    }
    if (!session) {
      if (c.req.method !== "POST") {
        return c.json({ error: "Initialize the MCP session first." }, 400);
      }
      if (sessions.size >= 200) {
        return c.json({ error: "Gateway session limit reached." }, 503);
      }
      let gateway: Gateway | undefined;
      try {
        const body = await c.req.raw.clone().json();
        if (body.method !== "initialize") {
          return c.json({ error: "Initialize the MCP session first." }, 400);
        }
        gateway = await Gateway.open(options);
        const id = crypto.randomUUID();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          supportedProtocolVersions: ["2025-11-25"],
          onsessioninitialized: () => {
            sessions.set(id, session!);
          },
          onsessionclosed: () => {
            sessions.delete(id);
            void gateway!.close();
          },
        });
        session = { gateway, transport, touched: Date.now() };
        transport.onclose = () => {
          sessions.delete(id);
          void gateway!.close();
        };
        await gateway.server.connect(transport);
        const response = await transport.handleRequest(c.req.raw);
        if (!sessions.has(id)) await gateway.close();
        return response;
      } catch {
        await gateway?.close();
        return c.json({
          error:
            "Could not connect to the board. Check the server URL and gateway credential.",
        }, 503);
      }
    }
    session.touched = Date.now();
    return await session.transport.handleRequest(c.req.raw);
  });
  const reap = setInterval(() => {
    for (const [sid, session] of sessions) {
      if (Date.now() - session.touched > 1800000) {
        sessions.delete(sid);
        void session.gateway.close();
        void session.transport.close();
      }
    }
  }, 60000);
  return {
    app,
    sessions,
    async close() {
      clearInterval(reap);
      await Promise.allSettled([...sessions.values()].map(async (s) => {
        await s.gateway.close();
        await s.transport.close();
      }));
      sessions.clear();
    },
  };
}
if (import.meta.main) {
  const options = optionsFromArgs(Deno.args);
  const service = createHttpGateway(options);
  const http = Deno.serve({
    hostname: options.host,
    port: options.port,
    onListen: ({ hostname, port }) =>
      console.error(
        "HTTP MCP gateway: http://" + hostname + ":" + port + "/mcp",
      ),
  }, service.app.fetch);
  const shutdown = async () => {
    await service.close();
    await http.shutdown();
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  }
  await http.finished;
}
