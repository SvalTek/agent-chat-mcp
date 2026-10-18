import { decodeCursor, encodeCursor } from "../storage/pagination.ts";
import type { BoardStore, Message } from "../domain/board.ts";
import type { AuthService } from "../auth/service.ts";
import { count, type Query, records } from "./query.ts";
import { getLogs } from "../infra/logs.ts";
export class Observability {
  readonly startedAt = new Date().toISOString();
  constructor(readonly store: BoardStore, readonly auth: AuthService) {}
  async overview() {
    await this.auth.cleanupExpiredSessions();
    const [agents, categories, conversations] = await Promise.all(
      ["account", "category", "thread"].map((p) => count(this.store.kv, [p])),
    );
    const recent: Message[] = [];
    let messages = 0;
    for await (
      const entry of this.store.kv.list<Message>({ prefix: ["message"] })
    ) {
      if (!await this.store.getMessage(entry.value.id)) continue;
      messages++;
      recent.push(entry.value);
      recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (recent.length > 8) recent.pop();
    }
    return {
      counts: {
        agents,
        categories,
        conversations,
        messages,
        sessions: this.auth.sessions.size,
      },
      startedAt: this.startedAt,
      recent,
      errors: getLogs({ level: "error", limit: 5 }),
    };
  }
  async sessions(query: Query = {}) {
    await this.auth.cleanupExpiredSessions();
    const scope = "owner-sessions:" + (query.q ?? "");
    const cursor = decodeCursor<string>(query.cursor, scope);
    const list = [...this.auth.sessions.values()].map((s) => ({
      ...s,
      kind: s.accountId ? "authenticated" : "anonymous",
    })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const q = query.q?.toLowerCase(),
      limit = Math.min(100, Math.max(1, query.limit ?? 30));
    const filtered = list.filter((s) =>
      (!cursor || s.sessionId > cursor) &&
      (!q || JSON.stringify(s).toLowerCase().includes(q))
    );
    const items = filtered.slice(0, limit);
    return {
      items,
      nextCursor: filtered.length > limit
        ? encodeCursor({ scope, value: items.at(-1)!.sessionId })
        : null,
    };
  }
  messages(query: Query = {}) {
    return records<Message>(
      this.store.kv,
      ["message"],
      query,
      async (m) =>
        Boolean(await this.store.getMessage(m.id)) &&
        (!query.agentId || m.senderAccountId === query.agentId),
    );
  }
  logs(level?: string) {
    return getLogs({
      limit: 200,
      ...(level ? { level: level as "error" } : {}),
    });
  }
}
