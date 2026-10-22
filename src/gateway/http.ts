import {
  Gateway,
  recordGatewayLog,
  type GatewayOptions,
  optionsFromArgs,
} from "./client.ts";
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
      cleanup?: Promise<void>;
    }
  >();
  const pendingCleanup = new Set<Promise<void>>();
  const closePart = async (
    sid: string,
    phase: string,
    operation: () => Promise<unknown>,
  ) => {
    const started = Date.now();
    recordGatewayLog("info", "http-gateway", `Cleanup ${phase} started`, sid);
    try {
      await operation();
      recordGatewayLog(
        "info",
        "http-gateway",
        `Cleanup ${phase} completed in ${Date.now() - started}ms`,
        sid,
      );
    } catch (error) {
      recordGatewayLog(
        "error",
        "http-gateway",
        `Cleanup ${phase} failed after ${Date.now() - started}ms: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        sid,
      );
    }
  };
  const cleanupSession = (sid: string) => {
    const session = sessions.get(sid);
    if (!session) return Promise.resolve();
    if (session.cleanup) return session.cleanup;
    sessions.delete(sid);
    const cleanup = Promise.all([
      closePart(sid, "upstream gateway", () => session.gateway.close()),
      closePart(sid, "downstream transport", () => session.transport.close()),
    ]).then(() => {});
    session.cleanup = cleanup;
    pendingCleanup.add(cleanup);
    void cleanup.finally(() => pendingCleanup.delete(cleanup)).catch((error) => {
      recordGatewayLog("error", "http-gateway", `Session cleanup bookkeeping failed: ${String(error)}`, sid);
    });
    return session.cleanup;
  };
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
      const id = crypto.randomUUID();
      try {
        const body = await c.req.raw.clone().json();
        if (body.method !== "initialize") {
          return c.json({ error: "Initialize the MCP session first." }, 400);
        }
        gateway = await Gateway.open(options);
        gateway.setDiagnosticSessionId(id);
        recordGatewayLog("info", "http-gateway", "MCP session initialized", id);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          supportedProtocolVersions: ["2025-11-25"],
          onsessioninitialized: () => {
            sessions.set(id, session!);
          },
          onsessionclosed: () => {
            void cleanupSession(id).catch((error) => {
              recordGatewayLog("error", "http-gateway", `Session close callback failed: ${String(error)}`, id);
            });
          },
        });
        session = { gateway, transport, touched: Date.now() };
        transport.onclose = () => {
          void cleanupSession(id).catch((error) => {
            recordGatewayLog("error", "http-gateway", `Transport close callback failed: ${String(error)}`, id);
          });
        };
        await gateway.server.connect(transport);
        const response = await transport.handleRequest(c.req.raw);
        if (!sessions.has(id)) await cleanupSession(id);
        return response;
      } catch (error) {
        recordGatewayLog(
          "error",
          "http-gateway",
          `MCP session initialization failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          id,
        );
        if (gateway) {
          gateway.setDiagnosticSessionId(id);
          await closePart(id, "failed initialization gateway", () => gateway!.close());
        }
        return c.json({
          error:
            "Could not connect to the board. Check the server URL and gateway credential.",
        }, 503);
      }
    }
    session.touched = Date.now();
    try {
      return await session.transport.handleRequest(c.req.raw);
    } catch (error) {
      recordGatewayLog(
        "error",
        "http-gateway",
        `MCP request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        sid,
      );
      return c.json({ error: "MCP request failed." }, 500);
    }
  });
  const reap = setInterval(() => {
    for (const [sid, session] of sessions) {
      if (Date.now() - session.touched > 1800000) {
        recordGatewayLog("info", "http-gateway", "Idle session expired", sid);
        void cleanupSession(sid).catch((error) => {
          recordGatewayLog("error", "http-gateway", `Idle cleanup failed: ${String(error)}`, sid);
        });
      }
    }
  }, 60000);
  return {
    app,
    sessions,
    async close() {
      clearInterval(reap);
      recordGatewayLog(
        "info",
        "http-gateway",
        `Service shutdown started with ${sessions.size} active session(s)`,
      );
      await Promise.all([...sessions.keys()].map((sid) => cleanupSession(sid)));
      await Promise.all([...pendingCleanup]);
      recordGatewayLog("info", "http-gateway", "Service shutdown completed");
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
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise) {
      console.error("Second Ctrl+C received; forcing exit.");
      Deno.exit(130);
    }
    console.error("Stopping HTTP MCP gateway...");
    recordGatewayLog("info", "http-gateway", "HTTP server shutdown requested");
    const deadline = setTimeout(() => {
      console.error(
        "Gateway cleanup exceeded 10 seconds; forcing exit.",
      );
      Deno.exit(130);
    }, 10_000);
    const shutdownHttp = async () => {
      const started = Date.now();
      recordGatewayLog("info", "http-gateway", "HTTP listener shutdown started");
      try {
        await http.shutdown();
        recordGatewayLog("info", "http-gateway", `HTTP listener shutdown completed in ${Date.now() - started}ms`);
      } catch (error) {
        recordGatewayLog("error", "http-gateway", `HTTP listener shutdown failed: ${String(error)}`);
        throw error;
      }
    };
    shutdownPromise = Promise.allSettled([
      service.close(),
      shutdownHttp(),
    ]).then((results) => {
      clearTimeout(deadline);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Gateway shutdown step failed:", result.reason);
        }
      }
    });
    return shutdownPromise;
  };
  Deno.addSignalListener("SIGINT", () => {
    void shutdown().catch((error) => recordGatewayLog("error", "http-gateway", `Shutdown failed: ${String(error)}`));
  });
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => {
      void shutdown().catch((error) => recordGatewayLog("error", "http-gateway", `Shutdown failed: ${String(error)}`));
    });
  }
  await http.finished;
  await shutdownPromise;
}
