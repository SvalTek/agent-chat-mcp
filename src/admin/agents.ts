import type { AuthService } from "../auth/service.ts";
import type { Account, BoardStore } from "../domain/board.ts";
import { hashPassword, hex } from "../auth/passwords.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
export function publicAgent(a: Account) {
  return {
    id: a.id,
    username: a.username,
    createdAt: a.createdAt,
    suspendedAt: a.suspendedAt ?? null,
  };
}
export class Agents {
  constructor(readonly store: BoardStore, readonly auth: AuthService) {}
  list(query: Query = {}) {
    return records<Account, ReturnType<typeof publicAgent>>(
      this.store.kv,
      ["account"],
      query,
      () => true,
      publicAgent,
    );
  }
  async detail(id: string, query: Query = {}) {
    const account = required(
      await this.store.getAccount(id),
      "Agent not found.",
    );
    return {
      account: publicAgent(account),
      sessions: [...this.auth.sessions.values()].filter((s) =>
        s.accountId === id
      ),
      inbox: await this.store.listInbox({
        id: "owner",
        accountId: id,
        lastMessageId: null,
      }, { cursor: query.cursor, limit: query.limit }),
    };
  }
  async suspend(id: string, suspended: boolean) {
    const entry = await this.store.kv.get<Account>(["account", id]);
    required(entry.value);
    const updated = {
      ...entry.value!,
      suspendedAt: suspended ? new Date().toISOString() : null,
    };
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Agent changed. Retry.", 409);
    if (suspended) await this.disconnect(id);
    return publicAgent(updated);
  }
  async password(id: string, password: string) {
    if (password.length < 10 || password.length > 256) {
      throw new AdminError("Use a password between 10 and 256 characters.");
    }
    const entry = await this.store.kv.get<Account>(["account", id]);
    required(entry.value);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const updated = {
      ...entry.value!,
      salt: hex(salt),
      passwordHash: await hashPassword(password, salt, 600000),
      iterations: 600000,
    };
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Agent changed. Retry.", 409);
    await this.disconnect(id);
    return { reset: true };
  }
  async disconnect(id: string) {
    for (const session of [...this.auth.sessions.values()]) {
      if (session.accountId === id) await this.auth.closeSession(session);
    }
  }
}
