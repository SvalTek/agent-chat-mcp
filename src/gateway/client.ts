import { MCPClient, type MCPConnection } from "@mcp-use/client";
import { Server } from "@mcp/server";

export interface GatewayOptions {
  url?: string;
  gatewayToken?: string;
}
export interface GatewayLogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: "http-gateway" | "mcp-gateway";
  message: string;
  context?: { sessionId?: string };
}
const gatewayLogs: GatewayLogEntry[] = [];
const MAX_GATEWAY_LOGS = 500;
export function recordGatewayLog(
  level: GatewayLogEntry["level"],
  source: GatewayLogEntry["source"],
  message: string,
  sessionId?: string,
) {
  const safeMessage = message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/("?(?:password|accessToken|gatewayToken|authorization)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, "$1[redacted]");
  const entry: GatewayLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message: safeMessage,
    ...(sessionId ? { context: { sessionId } } : {}),
  };
  gatewayLogs.push(entry);
  if (gatewayLogs.length > MAX_GATEWAY_LOGS) {
    gatewayLogs.splice(0, gatewayLogs.length - MAX_GATEWAY_LOGS);
  }
  console.error(`[${source}] ${safeMessage}${sessionId ? ` (session ${sessionId})` : ""}`);
}
export function getGatewayLogs() {
  return gatewayLogs.slice();
}
export function optionsFromArgs(args: string[]) {
  const options = {
    url: Deno.env.get("AGENT_CHAT_BACKEND_URL") ?? "http://127.0.0.1:8787",
    gatewayToken: Deno.env.get("AGENT_CHAT_GATEWAY_TOKEN"),
    host: Deno.env.get("AGENT_CHAT_HTTP_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("AGENT_CHAT_HTTP_PORT") ?? 8788),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[++i];
    if (!value) throw new Error("Missing value for " + arg);
    if (arg === "--server") options.url = value;
    else if (arg === "--gateway-token") options.gatewayToken = value;
    else if (arg === "--host") options.host = value;
    else if (arg === "--port") options.port = Number(value);
    else throw new Error("Unknown option: " + arg);
  }
  if (
    !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
  ) throw new Error("Invalid port.");
  return options;
}
export class Gateway {
  private token = "";
  private expiresAt = 0;
  private client?: MCPClient;
  private connection?: MCPConnection;
  private connectedClientInfo = "";
  private socket?: WebSocket;
  private socketReady?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private diagnosticSessionId?: string;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly subscriptions = new Set<string>();
  readonly base: URL;
  readonly server: Server;
  setDiagnosticSessionId(sessionId: string) {
    this.diagnosticSessionId = sessionId;
  }
  constructor(readonly options: GatewayOptions = {}) {
    const url = new URL(
      options.url ?? Deno.env.get("AGENT_CHAT_BACKEND_URL") ??
        "http://127.0.0.1:8787",
    );
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password || url.search || url.hash ||
      !["/", "/mcp"].includes(url.pathname)
    ) {
      throw new Error(
        "--server must be an HTTP(S) origin or its /mcp endpoint.",
      );
    }
    this.base = new URL("/", url);
    this.server = new Server({
      name: "agent-chat-mcp-gateway",
      version: "1.0.0",
    }, {
      instructions:
        "Read agent-chat://skill before using the board. Use auth to register or reclaim your identity; retain credentials in private durable memory.",
      supportedProtocolVersions: ["2025-11-25"],
      capabilities: { tools: {}, resources: { subscribe: true } },
    });
    this.server.setRequestHandler(
      "tools/list",
      (req) =>
        this.run(async () =>
          await this.connection!.request(
            "tools/list",
            req.params ?? {},
          ) as never
        ),
    );
    this.server.setRequestHandler(
      "resources/list",
      (req) =>
        this.run(async () =>
          await this.connection!.request(
            "resources/list",
            req.params ?? {},
          ) as never
        ),
    );
    this.server.setRequestHandler(
      "resources/templates/list",
      (req) =>
        this.run(async () =>
          await this.connection!.request(
            "resources/templates/list",
            req.params ?? {},
          ) as never
        ),
    );
    this.server.setRequestHandler("tools/call", (req) =>
      this.run(async () => {
        try {
          if (req.params.name === "get_logs") {
            const result = await this.connection!.callTool(
              req.params.name,
              (req.params.arguments ?? {}) as Record<string, unknown>,
            ) as { content?: { type: string; text?: string }[] };
            const text = result.content?.find((item) => item.type === "text")
              ?.text;
            if (text) {
              try {
                const args = (req.params.arguments ?? {}) as {
                  limit?: number;
                  level?: GatewayLogEntry["level"];
                };
                const backend = JSON.parse(text);
                if (Array.isArray(backend)) {
                  const merged = [...backend, ...getGatewayLogs()]
                    .filter((entry) => !args.level || entry.level === args.level)
                    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
                    .slice(-Math.min(Math.max(args.limit ?? 100, 1), 500));
                  return {
                    ...result,
                    content: result.content!.map((item) =>
                      item.type === "text" ? { ...item, text: JSON.stringify(merged, null, 2) } : item
                    ),
                  };
                }
              } catch { /* Preserve the upstream response if it is not JSON. */ }
            }
            return result;
          }
          if (req.params.name === "auth") {
            const args = req.params.arguments ?? {};
            const data = await this.api("/auth/agent", {
              username: args.username,
              password: args.password,
            });
            this.stopSocket();
            this.subscriptions.clear();
            this.setToken(data);
            await this.connectMcp();
            return {
              content: [{ type: "text", text: JSON.stringify(data.status) }],
            };
          }
          return await this.connection!.callTool(
            req.params.name,
            (req.params.arguments ?? {}) as Record<string, unknown>,
          ) as never;
        } catch (error) {
          recordGatewayLog(
            "error",
            "mcp-gateway",
            `Tool ${req.params.name} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
            this.diagnosticSessionId,
          );
          return {
            isError: true,
            content: [{
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Board operation failed.",
            }],
          };
        }
      }) as never);
    this.server.setRequestHandler(
      "resources/read",
      (req) =>
        this.run(async () =>
          await this.connection!.readResource(req.params.uri) as never
        ),
    );
    this.server.setRequestHandler(
      "resources/subscribe",
      (req) =>
        this.run(async () => {
          await this.ensureSocket();
          await this.socketRequest("subscribe", req.params.uri);
          this.subscriptions.add(req.params.uri);
          return {};
        }),
    );
    this.server.setRequestHandler(
      "resources/unsubscribe",
      (req) =>
        this.run(async () => {
          this.subscriptions.delete(req.params.uri);
          if (this.socket?.readyState === WebSocket.OPEN) {
            await this.socketRequest("unsubscribe", req.params.uri);
          }
          return {};
        }),
    );
  }
  static async open(options: GatewayOptions = {}) {
    const gateway = new Gateway(options);
    try {
      const response = await fetch(new URL("/auth/session", gateway.base), {
        method: "POST",
        headers: options.gatewayToken
          ? { authorization: "Bearer " + options.gatewayToken }
          : {},
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Could not create board session.");
      }
      gateway.setToken(data);
      await gateway.connectMcp();
      return gateway;
    } catch (error) {
      recordGatewayLog(
        "error",
        "mcp-gateway",
        `Gateway startup failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      try {
        await gateway.close();
      } catch (closeError) {
        recordGatewayLog(
          "error",
          "mcp-gateway",
          `Startup cleanup failed: ${closeError instanceof Error ? `${closeError.name}: ${closeError.message}` : String(closeError)}`,
        );
      }
      throw error;
    }
  }
  private setToken(data: { accessToken: string; expiresIn: number }) {
    if (!data.accessToken || !data.expiresIn) {
      throw new Error("Invalid token response.");
    }
    this.token = data.accessToken;
    this.expiresAt = Date.now() + data.expiresIn * 1000;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.run(async () => {}).catch(() =>
        console.error(
          "Board session refresh failed; reconnect if the session expires.",
        )
      );
    }, Math.max(1000, data.expiresIn * 1000 - 30000));
  }
  private async api(
    path: string,
    body?: unknown,
    method = "POST",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(new URL(path, this.base), {
      method,
      headers: {
        ...this.clientHeaders(),
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Authentication request failed.");
    }
    return data;
  }
  private clientHeaders(): Record<string, string> {
    const info = this.server.getClientVersion();
    const clean = (value: string) =>
      value.replace(/[^\x20-\x7E]/g, "").slice(0, 100);
    return info
      ? {
        "x-agent-chat-client-name": clean(info.name),
        "x-agent-chat-client-version": clean(info.version),
      }
      : {};
  }
  private async connectMcp() {
    const old = this.client;
    this.connection = undefined;
    this.client = undefined;
    if (old) await old.close();
    const headers = this.clientHeaders();
    const client = MCPClient.fromDict({
      mcpServers: {
        board: {
          url: new URL("/mcp", this.base).href,
          oauth: false,
          authToken: this.token,
          headers,
        },
      },
    });
    try {
      this.connection = await client.connect("board");
      this.client = client;
      this.connectedClientInfo = JSON.stringify(headers);
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error("Gateway closed.");
      if (Date.now() >= this.expiresAt - 30000) {
        this.setToken(
          await this.api(
            "/auth/refresh",
            undefined,
            "POST",
            this.options.gatewayToken
              ? { "x-agent-chat-gateway-token": this.options.gatewayToken }
              : {},
          ),
        );
        this.stopSocket();
        await this.connectMcp();
        if (this.subscriptions.size) await this.ensureSocket();
      }
      if (
        !this.connection ||
        this.connectedClientInfo !== JSON.stringify(this.clientHeaders())
      ) await this.connectMcp();
      return await operation();
    });
    void result.catch((error) => {
      recordGatewayLog(
        "error",
        "mcp-gateway",
        `Request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        this.diagnosticSessionId,
      );
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private stopSocket() {
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    this.socketReady = undefined;
    socket?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Event connection reset."));
    }
    this.pending.clear();
  }
  private socketRequest(type: string, uri: string) {
    return new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Event subscription timed out."));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type, uri, id }));
    });
  }
  private ensureSocket(): Promise<void> {
    if (this.socketReady) return this.socketReady;
    const generation = this.generation;
    const url = new URL("/events", this.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.socketReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Event connection timed out."));
        socket.close();
      }, 8000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ type: "authenticate", token: this.token }),
        );
      socket.onmessage = (event) => {
        if (generation !== this.generation || this.closed) return;
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === "ready") {
            clearTimeout(timer);
            resolve();
            for (const uri of this.subscriptions) {
              void this.socketRequest("subscribe", uri).then(() =>
                this.notify(uri)
              ).catch(() => {});
            }
          } else if (data.id && this.pending.has(data.id)) {
            const pending = this.pending.get(data.id)!;
            clearTimeout(pending.timer);
            this.pending.delete(data.id);
            if (data.type === "error") pending.reject(new Error(data.message));
            else pending.resolve();
          } else if (
            data.type === "resource_changed" && this.subscriptions.has(data.uri)
          ) this.notify(data.uri);
        } catch {
          console.error("Invalid event frame.");
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Event connection failed."));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        reject(new Error("Event connection closed."));
        if (generation !== this.generation || this.closed) return;
        this.socket = undefined;
        this.socketReady = undefined;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Event connection closed."));
        }
        this.pending.clear();
        if (this.subscriptions.size) {
          this.retry = setTimeout(() => {
            void this.run(async () => {
              await this.ensureSocket();
            }).catch(() => {});
          }, 1000);
        }
      };
    });
    return this.socketReady;
  }
  private notify(uri: string) {
    void this.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    }).catch(() => {});
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const started = Date.now();
    recordGatewayLog("info", "mcp-gateway", "Gateway close started", this.diagnosticSessionId);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.stopSocket();
    const client = this.client;
    this.client = undefined;
    this.connection = undefined;
    if (this.token) {
      try {
        recordGatewayLog("info", "mcp-gateway", "Backend session deletion started", this.diagnosticSessionId);
        await this.api("/auth/session", undefined, "DELETE");
        recordGatewayLog("info", "mcp-gateway", "Backend session deletion completed", this.diagnosticSessionId);
      } catch (error) {
        recordGatewayLog(
          "warn",
          "mcp-gateway",
          `Backend session deletion failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          this.diagnosticSessionId,
        );
      }
    }
    this.token = "";
    this.subscriptions.clear();
    if (client) {
      try {
        recordGatewayLog("info", "mcp-gateway", "Upstream MCP client close started", this.diagnosticSessionId);
        await client.close();
        recordGatewayLog("info", "mcp-gateway", "Upstream MCP client close completed", this.diagnosticSessionId);
      } catch (error) {
        recordGatewayLog(
          "error",
          "mcp-gateway",
          `Upstream MCP client close failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          this.diagnosticSessionId,
        );
        throw error;
      }
    }
    recordGatewayLog("info", "mcp-gateway", `Gateway close completed in ${Date.now() - started}ms`, this.diagnosticSessionId);
  }
}
