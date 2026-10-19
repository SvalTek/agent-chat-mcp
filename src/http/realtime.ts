import { Hono } from "hono";
import { upgradeWebSocket } from "@hono/deno";
import type { WSContext } from "hono/ws";
import type { AgentPrincipal, AuthService } from "../auth/service.ts";
import type { BoardStore } from "../domain/board.ts";
import { recordLog } from "../infra/logs.ts";

export async function authorizeResource(
  store: BoardStore,
  auth: AuthService,
  principal: AgentPrincipal,
  input: string,
) {
  const uri = new URL(input);
  if (
    uri.protocol !== "agent-chat:" || uri.username || uri.password || uri.hash
  ) throw new Error("Invalid resource URI.");
  const base = uri.origin === "null"
    ? "agent-chat://" + uri.host + uri.pathname
    : uri.origin + uri.pathname;
  if (
    base === "agent-chat://categories" ||
    base === "agent-chat://feed" ||
    base === "agent-chat://agents" ||
    /^agent-chat:\/\/agents\/[\w-]+$/.test(base) ||
    /^agent-chat:\/\/categories\/[\w-]+\/threads$/.test(base)
  ) return base;
  if (base === "agent-chat://inbox/me" && principal.accountId) return base;
  const threadId = /^agent-chat:\/\/threads\/([\w-]+)$/.exec(base)?.[1];
  if (threadId && (await store.getThread(threadId))?.kind === "public") {
    return base;
  }
  const dmId = /^agent-chat:\/\/dms\/([\w-]+)$/.exec(base)?.[1];
  if (dmId && await store.canReadDm(auth.identity(principal), dmId)) {
    return base;
  }
  throw new Error("Resource is unavailable to this identity.");
}
export function createRealtime(store: BoardStore, auth: AuthService) {
  const app = new Hono();
  const sockets = new Map<
    WSContext,
    {
      principal?: AgentPrincipal;
      token?: string;
      subscriptions: Map<string, string>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const changed = (sid: string) => {
    for (const [ws, state] of sockets) {
      if (state.principal?.sessionId === sid) {
        state.subscriptions.clear();
        ws.close(4001, "Identity changed; authenticate and resubscribe.");
      }
    }
  };
  auth.changed.add(changed);
  app.get(
    "/events",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const timer = setTimeout(
          () => ws.close(4003, "Authentication timeout."),
          5000,
        );
        sockets.set(ws, { subscriptions: new Map(), timer });
      },
      async onMessage(event, ws) {
        const state = sockets.get(ws);
        if (!state) return;
        try {
          if (
            typeof event.data !== "string" || event.data.length > 8192
          ) throw new Error("Invalid event request.");
          const input = JSON.parse(event.data);
          if (input.type === "authenticate") {
            state.subscriptions.clear();
            state.principal = undefined;
            state.token = undefined;
            const principal = await auth.verifyAgent(String(input.token ?? ""));
            if (!sockets.has(ws)) return;
            state.principal = principal;
            state.token = input.token;
            clearTimeout(state.timer);
            state.timer = setTimeout(
              () => ws.close(4003, "Token expired; reconnect."),
              Math.max(
                0,
                Number(
                      JSON.parse(
                        atob(
                          input.token.split(".")[1].replaceAll("-", "+")
                            .replaceAll("_", "/"),
                        ),
                      ).exp,
                    ) * 1000 - Date.now(),
              ),
            );
            ws.send(JSON.stringify({ type: "ready" }));
            return;
          }
          if (!state.principal || !state.token) {
            throw new Error(
              "Authenticate first.",
            );
          }
          const principal = await auth.verifyAgent(state.token);
          if (input.type === "subscribe") {
            if (state.subscriptions.size >= 100) {
              throw new Error(
                "Subscription limit reached.",
              );
            }
            const uri = String(input.uri);
            const base = await authorizeResource(store, auth, principal, uri);
            if (
              state.principal.sessionId !== principal.sessionId ||
              state.principal.revision !== principal.revision ||
              auth.sessions.get(principal.sessionId)?.revision !==
                principal.revision
            ) throw new Error("Identity changed.");
            state.subscriptions.set(uri, base);
            recordLog(
              "info",
              "websocket",
              "Resource subscription added.",
              principal,
            );
            ws.send(JSON.stringify({ type: "subscribed", uri, id: input.id }));
          } else if (input.type === "unsubscribe") {
            state.subscriptions.delete(String(input.uri));
            recordLog(
              "info",
              "websocket",
              "Resource subscription removed.",
              principal,
            );
            ws.send(
              JSON.stringify({
                type: "unsubscribed",
                uri: input.uri,
                id: input.id,
              }),
            );
          } else if (input.type === "ping") {
            ws.send(
              JSON.stringify({ type: "pong" }),
            );
          } else throw new Error("Unknown event request.");
        } catch {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Event request rejected.",
              id: (() => {
                try {
                  return JSON.parse(String(event.data)).id;
                } catch {
                  return undefined;
                }
              })(),
            }),
          );
        }
      },
      onClose(_event, ws) {
        const state = sockets.get(ws);
        if (state) clearTimeout(state.timer);
        sockets.delete(ws);
      },
      onError(_event, ws) {
        recordLog(
          "warn",
          "websocket",
          "WebSocket connection error.",
          sockets.get(ws)?.principal,
        );
      },
    })),
  );
  const unsubscribe = store.events.subscribe((event) => {
    for (const [ws, state] of sockets) {
      if (
        !state.principal ||
        auth.sessions.get(state.principal.sessionId)?.revision !==
          state.principal.revision
      ) continue;
      const changedUris = new Set([
        ...event.publicUris,
        ...(state.principal.accountId
          ? event.accountUris[state.principal.accountId] ?? []
          : []),
      ]);
      for (const [uri, base] of state.subscriptions) {
        if (changedUris.has(base)) {
          try {
            ws.send(JSON.stringify({ type: "resource_changed", uri }));
          } catch {
            recordLog(
              "warn",
              "websocket",
              "Could not send resource update.",
              state.principal,
            );
          }
        }
      }
    }
  });
  return {
    app,
    close() {
      unsubscribe();
      auth.changed.delete(changed);
      for (const [ws, state] of sockets) {
        clearTimeout(state.timer);
        ws.close(1001, "Server shutting down.");
      }
      sockets.clear();
    },
  };
}
