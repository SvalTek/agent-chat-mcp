import type { BoardStore, Message, Thread } from "../domain/board.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
export class Conversations {
  constructor(readonly store: BoardStore) {}
  async list(query: Query) {
    const page = await records<Thread>(
      this.store.kv,
      ["thread"],
      query,
      async (thread) => {
        if (
          !await this.store.getThread(thread.id) ||
          query.kind && thread.kind !== query.kind ||
          query.categoryId && thread.categoryId !== query.categoryId
        ) return false;
        let authored = !query.agentId ||
          thread.participants.includes(query.agentId) ||
          thread.createdByAccountId === query.agentId;
        let matches = !query.q ||
          thread.title.toLowerCase().includes(query.q.toLowerCase());
        if (!authored || !matches) {
          for await (
            const entry of this.store.kv.list<string>({
              prefix: ["thread-message", thread.id],
            })
          ) {
            const message = await this.store.getMessage(entry.value);
            if (!message) continue;
            if (
              query.agentId && message.senderAccountId === query.agentId
            ) authored = true;
            if (
              query.q &&
              message.text.toLowerCase().includes(query.q.toLowerCase())
            ) matches = true;
            if (authored && matches) break;
          }
        }
        return authored && matches;
      },
      (thread) => thread,
      false,
    );
    return {
      ...page,
      items: await Promise.all(page.items.map(async (thread) => ({
        ...thread,
        participantNames: await Promise.all(
          thread.participants.map(async (id) =>
            (await this.store.getAccount(id))?.username ?? id
          ),
        ),
        categoryName: thread.categoryId
          ? (await this.store.getCategory(thread.categoryId))?.name
          : null,
      }))),
    };
  }
  async detail(id: string, query: Query = {}) {
    const thread = required(
      await this.store.getThread(id),
      "Conversation not found.",
    );
    const page = await records<string>(
      this.store.kv,
      ["thread-message", id],
      { ...query, q: undefined },
      async (id) => Boolean(await this.store.getMessage(id)),
    );
    const messages = [];
    // Thread-message entries contain message IDs. Resolve each through the domain visibility rules.
    for (const value of page.items) {
      const message = await this.store.getMessage(value);
      if (message) messages.push(message);
    }
    return {
      thread,
      participants: await Promise.all(
        thread.participants.map(async (id) => ({
          id,
          username: (await this.store.getAccount(id))?.username ?? id,
        })),
      ),
      messages: { ...page, items: messages },
    };
  }
  async update(id: string, title: string) {
    const entry = await this.store.kv.get<Thread>(["thread", id]);
    required(entry.value);
    if (!title.trim() || title.length > 120) {
      throw new AdminError("Use a title between 1 and 120 characters.");
    }
    const updated = { ...entry.value!, title: title.trim() };
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Conversation changed. Reload and retry.", 409);
    this.publish(updated);
    return updated;
  }
  async remove(id: string) {
    const entry = await this.store.kv.get<Thread>(["thread", id]);
    const thread = required(entry.value);
    const operation = this.store.kv.atomic().check(entry).set(entry.key, {
      ...thread,
      deletedAt: new Date().toISOString(),
    });
    // Release the pair in the same commit so a new DM cannot lose its mapping.
    if (thread.kind === "dm") {
      const pair = await this.store.kv.get<string>([
        "dm-pair",
        ...thread.participants.slice().sort(),
      ]);
      if (pair.value === thread.id) operation.check(pair).delete(pair.key);
    }
    if (!(await operation.commit()).ok) {
      throw new AdminError("Conversation changed. Reload and retry.", 409);
    }
    this.publish(thread);
    return { deleted: true };
  }
  async editMessage(id: string, text: string) {
    const entry = await this.store.kv.get<Message>(["message", id]);
    const message = required(entry.value);
    if (message.deletedAt) {
      throw new AdminError("Message has been deleted.", 404);
    }
    if (
      !text.trim() || text.length > 20000 ||
      new TextEncoder().encode(text).length > 48000
    ) {
      throw new AdminError(
        "Message must contain 1–20000 characters and fit within 48000 UTF-8 bytes.",
      );
    }
    const updated = {
      ...message,
      text: text.trim(),
      editedAt: new Date().toISOString(),
      editedByOwner: true,
    };
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Message changed. Reload and retry.", 409);
    const thread = await this.store.getThread(message.threadId);
    if (thread) this.publish(thread);
    return updated;
  }
  async deleteMessage(id: string) {
    const entry = await this.store.kv.get<Message>(["message", id]);
    const message = required(entry.value);
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, {
        ...message,
        text: "",
        mentions: [],
        deletedAt: new Date().toISOString(),
      }).commit()).ok
    ) throw new AdminError("Message changed. Reload and retry.", 409);
    const thread = await this.store.getThread(message.threadId);
    if (thread) this.publish(thread);
    return { deleted: true };
  }
  /**
   * Signals public category, feed, and thread views for public conversations;
   * signals participant DM and inbox views for private conversations.
   */
  publish(thread: Thread) {
    this.store.events.publish({
      publicUris: thread.kind === "public"
        ? [
          "agent-chat://categories",
          "agent-chat://feed",
          "agent-chat://threads/" + thread.id,
          "agent-chat://categories/" + thread.categoryId + "/threads",
        ]
        : [],
      accountUris: Object.fromEntries(
        thread.participants.map(
          (id) => [id, [
            "agent-chat://dms/" + thread.id,
            "agent-chat://inbox/me",
          ]],
        ),
      ),
    });
  }
}
