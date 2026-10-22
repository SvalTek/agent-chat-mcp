import type { AuthService } from "../auth/service.ts";
import type { Account, BoardStore } from "../domain/board.ts";
import { hashPassword, hex } from "../auth/passwords.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
import type { Integration } from "../auth/integrations.ts";
import { deleteMatching } from "./purge.ts";
export function publicAgent(a: Account) {
  return {
    id: a.id,
    username: a.username,
    description: a.description ?? null,
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
  async updateProfile(id: string, descriptionInput: string) {
    const description = descriptionInput.trim();
    if (description.length > 500) {
      throw new AdminError(
        "A profile description is limited to 500 characters.",
      );
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.store.kv.get<Account>(["account", id]);
      const account = required(entry.value, "Agent not found.");
      const updated: Account = { ...account };
      if (description) updated.description = description;
      else delete updated.description;
      if (
        (await this.store.kv.atomic().check(entry).set(entry.key, updated)
          .commit()).ok
      ) {
        this.store.events.publish({
          publicUris: ["agent-chat://agents", "agent-chat://agents/" + id],
          accountUris: {},
        });
        return publicAgent(updated);
      }
    }
    throw new AdminError("Agent changed. Retry.", 409);
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
  async remove(id: string) {
    const kv = this.store.kv;
    const entry = await kv.get<Account>(["account", id]);
    const account = required(entry.value, "Agent not found.");
    if (!account.suspendedAt) {
      throw new AdminError(
        "Suspend the agent before permanently deleting it.",
        409,
      );
    }
    for (const session of [...this.auth.sessions.values()]) {
      if (session.accountId === id) await this.auth.closeSession(session);
    }
    const integrations: Integration[] = [];
    for await (
      const item of kv.list<Integration>({ prefix: ["integration"] })
    ) {
      if (item.value.accountId !== id) continue;
      if (
        !item.value.revokedAt && Date.parse(item.value.expiresAt) > Date.now()
      ) {
        throw new AdminError(
          "Revoke the agent's active integration before permanently deleting it.",
          409,
        );
      }
      integrations.push(item.value);
    }
    const identity = { id: "owner-purge", accountId: id, lastMessageId: null };
    const followedThreads: string[] = [];
    for await (const item of kv.list({ prefix: ["follow", id] })) {
      followedThreads.push(String(item.key.at(-1)));
    }
    for (const threadId of followedThreads) {
      await this.store.unfollowThread(identity, threadId);
    }
    await deleteMatching(
      kv,
      ["thread-follower"],
      (_value, key) => key.at(-1) === id,
    );
    await deleteMatching(kv, ["inbox", id]);
    await kv.delete(["inbox-read", id]);
    await deleteMatching(kv, ["idem", id]);
    for (const integration of integrations) {
      await kv.delete(["integration", integration.id]);
      await kv.delete([
        "integration-client",
        integration.clientId.normalize("NFKC").trim().toLowerCase(),
      ]);
    }
    const usernameEntry = await kv.get<string>([
      "username",
      account.normalizedUsername,
    ]);
    const operation = kv.atomic().check(entry).delete(entry.key);
    if (usernameEntry.value === id) {
      operation.check(usernameEntry).delete(usernameEntry.key);
    }
    if (!(await operation.commit()).ok) {
      throw new AdminError("Agent changed during deletion. Retry.", 409);
    }
    this.store.events.publish({
      publicUris: ["agent-chat://agents"],
      accountUris: { [id]: ["agent-chat://inbox/me"] },
    });
    return { deleted: true };
  }
  /**
   * Sets or clears suspension and returns the public account fields. Suspending
   * closes active sessions; both actions publish directory and profile updates.
   * Throws AdminError for a missing account (404) or concurrent change (409).
   * Storage and session-close errors propagate, possibly after suspension is saved.
   */
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
    // Suspension hides the account from the directory, and reactivation shows it.
    this.store.events.publish({
      publicUris: ["agent-chat://agents", "agent-chat://agents/" + id],
      accountUris: {},
    });
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
