import { issueAccessToken } from "./src/auth/access-tokens.ts";
import { BoardStore } from "./src/domain/board.ts";
import { type AuthOptions, AuthService } from "./src/auth/service.ts";
import { createApp } from "./src/app.ts";
import { loadEnvironment } from "./src/config/environment.ts";
export function parseArgs(args: string[]) {
  const options = {
    host: Deno.env.get("AGENT_CHAT_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("AGENT_CHAT_PORT") ?? 8787),
    kv: Deno.env.get("AGENT_CHAT_KV_PATH") ?? "./data/agent-chat.kv",
    issueToken: "",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (!next) throw new Error("Missing value for " + arg);
      return next;
    };
    if (arg === "--host") options.host = value();
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--kv") options.kv = value();
    else if (arg === "--issue-token") options.issueToken = value();
    else if (arg === "--help") {
      console.log(
        "Usage: deno task start [--host 127.0.0.1] [--port 8787] [--kv ./data/agent-chat.kv] [--issue-token gateway|api]",
      );
      Deno.exit(0);
    } else throw new Error("Unknown option: " + arg);
  }
  if (
    !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
  ) throw new Error("--port must be 0–65535.");
  return options;
}
if (import.meta.main) {
  await loadEnvironment();
  const options = parseArgs(Deno.args);
  const authOptions: AuthOptions = {
    secret: Deno.env.get("AGENT_CHAT_JWT_SECRET") ?? "",
    issuer: Deno.env.get("AGENT_CHAT_JWT_ISSUER"),
    ttlSeconds: Number(Deno.env.get("AGENT_CHAT_JWT_TTL_SECONDS") ?? 3600),
    requireGateway: Deno.env.get("AGENT_CHAT_REQUIRE_GATEWAY_AUTH") === "1" ||
      !["127.0.0.1", "localhost", "::1"].includes(options.host),
  };
  const store = await BoardStore.open(options.kv);
  const auth = new AuthService(store, authOptions);
  if (options.issueToken) {
    if (!["gateway", "api"].includes(options.issueToken)) {
      throw new Error("--issue-token must be gateway or api.");
    }
    console.log(
      (await issueAccessToken(
        auth,
        options.issueToken as "gateway" | "api",
        "owner-issued",
      )).token,
    );
    store.close();
  } else {
    const service = createApp({ store, auth });
    const http = Deno.serve({
      hostname: options.host,
      port: options.port,
      onListen: ({ hostname, port }) =>
        console.log(
          "Agent Messageboard listening on http://" + hostname + ":" + port,
        ),
    }, service.app.fetch);
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await service.close();
      await http.shutdown();
      store.close();
    };
    Deno.addSignalListener("SIGINT", () => void shutdown());
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGTERM", () => void shutdown());
    }
    await http.finished;
  }
}
