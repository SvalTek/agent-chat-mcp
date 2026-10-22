import type { BoardStore, Message, Thread } from "../domain/board.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
import { purgeConversation, purgeMessage } from "./purge.ts";
export class Conversations {
  constructor(readonly store: BoardStore) {}
  async list(query: Query) {
    const page = await records<Thread>(
      this.store.kv,
      ["thread"],
      query,
      async (thread) => {
        if (
          query.kind && thread.kind !== query.kind ||
          query.categoryId && thread.categoryId !== query.categoryId
        ) return false;
        const category = thread.categoryId
          ? (await this.store.kv.get<{
            archivedAt: string | null;
            deletedAt?: string;
            purgingAt?: string;
          }>(["category", thread.categoryId])).value
          : null;
        const archived = Boolean(
          thread.archivedAt || thread.deletedAt || thread.purgingAt ||
            category?.archivedAt || category?.deletedAt || category?.purgingAt,
        );
        if (
          query.status === "archived" && !archived ||
          query.status === "active" && archived
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
            const message = (await this.store.kv.get<Message>([
              "message",
              entry.value,
            ])).value;
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
      items: await Promise.all(page.items.map(async (thread) => {
        const category = thread.categoryId
          ? (await this.store.kv.get<{
            archivedAt: string | null;
            deletedAt?: string;
            name: string;
            purgingAt?: string;
          }>(["category", thread.categoryId])).value
          : null;
        return {
          ...thread,
          archived: Boolean(
            thread.archivedAt || thread.deletedAt || thread.purgingAt ||
              category?.archivedAt || category?.deletedAt ||
              category?.purgingAt,
          ),
          participantNames: await Promise.all(
            thread.participants.map(async (id) =>
              (await this.store.getAccount(id))?.username ?? id
            ),
          ),
          categoryName: category?.name ?? null,
        };
      })),
    };
  }
  async detail(id: string, query: Query = {}) {
    const thread = required(
      (await this.store.kv.get<Thread>(["thread", id])).value,
      "Conversation not found.",
    );
    const category = thread.categoryId
      ? (await this.store.kv.get<{
        archivedAt: string | null;
        deletedAt?: string;
        purgingAt?: string;
      }>([
        "category",
        thread.categoryId,
      ])).value
      : null;
    const archived = Boolean(
      thread.archivedAt || thread.deletedAt || thread.purgingAt ||
        category?.archivedAt || category?.deletedAt || category?.purgingAt,
    );
    const page = await records<string>(
      this.store.kv,
      ["thread-message", id],
      { ...query, q: undefined },
      async (messageId) => {
        const message = (await this.store.kv.get<Message>([
          "message",
          messageId,
        ])).value;
        return Boolean(message && (archived || !message.deletedAt));
      },
    );
    const messages = [];
    // Owners can inspect archived content while it awaits permanent removal.
    for (const value of page.items) {
      const message = (await this.store.kv.get<Message>(["message", value]))
        .value;
      if (message) messages.push(message);
    }
    return {
      thread: {
        ...thread,
        archived,
        categoryArchived: Boolean(
          category?.archivedAt || category?.deletedAt || category?.purgingAt,
        ),
      },
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
    const thread = required(entry.value);
    if (thread.archivedAt || thread.deletedAt || thread.purgingAt) {
      throw new AdminError("Archived conversations are read-only.", 409);
    }
    const categoryEntry = thread.categoryId
      ? await this.store.kv.get<{
        archivedAt: string | null;
        deletedAt?: string;
        purgingAt?: string;
      }>([
        "category",
        thread.categoryId,
      ])
      : null;
    if (
      categoryEntry?.value?.archivedAt || categoryEntry?.value?.deletedAt ||
      categoryEntry?.value?.purgingAt
    ) {
      throw new AdminError("Archived categories are read-only.", 409);
    }
    if (!title.trim() || title.length > 120) {
      throw new AdminError("Use a title between 1 and 120 characters.");
    }
    const updated = { ...thread, title: title.trim() };
    const operation = this.store.kv.atomic().check(entry);
    if (categoryEntry) operation.check(categoryEntry);
    if (!(await operation.set(entry.key, updated).commit()).ok) {
      throw new AdminError("Conversation changed. Reload and retry.", 409);
    }
    this.publish(updated);
    return updated;
  }
  async remove(id: string) {
    return await purgeConversation(this.store, id);
  }
  async purgeMessage(id: string) {
    return await purgeMessage(this.store, id);
  }
  async archive(id: string, archived: boolean) {
    const entry = await this.store.kv.get<Thread>(["thread", id]);
    const thread = required(entry.value);
    if (thread.deletedAt || thread.purgingAt) {
      throw new AdminError("Conversation is already being purged.", 409);
    }
    const categoryEntry = thread.categoryId
      ? await this.store.kv.get<{
        archivedAt: string | null;
        deletedAt?: string;
        purgingAt?: string;
      }>([
        "category",
        thread.categoryId,
      ])
      : null;
    if (
      !archived && (
        categoryEntry?.value?.archivedAt || categoryEntry?.value?.deletedAt ||
        categoryEntry?.value?.purgingAt
      )
    ) {
      throw new AdminError(
        "Reopen the category before unarchiving its conversations.",
        409,
      );
    }
    const updated = {
      ...thread,
      archivedAt: archived ? new Date().toISOString() : null,
    };
    const operation = this.store.kv.atomic().check(entry);
    if (categoryEntry) operation.check(categoryEntry);
    if (!(await operation.set(entry.key, updated).commit()).ok) {
      throw new AdminError("Conversation changed. Retry.", 409);
    }
    this.publish(updated);
    return updated;
  }
  async editMessage(id: string, text: string) {
    const entry = await this.store.kv.get<Message>(["message", id]);
    const message = required(entry.value);
    if (message.deletedAt) {
      throw new AdminError("Message has been deleted.", 404);
    }
    const threadEntry = await this.store.kv.get<Thread>([
      "thread",
      message.threadId,
    ]);
    const threadRecord = required(threadEntry.value, "Conversation not found.");
    if (
      threadRecord.archivedAt || threadRecord.deletedAt ||
      threadRecord.purgingAt
    ) {
      throw new AdminError("Archived conversations are read-only.", 409);
    }
    const categoryEntry = threadRecord.categoryId
      ? await this.store.kv.get<{
        archivedAt: string | null;
        deletedAt?: string;
        purgingAt?: string;
      }>([
        "category",
        threadRecord.categoryId,
      ])
      : null;
    if (categoryEntry) {
      const category = categoryEntry.value;
      if (
        category?.archivedAt || category?.deletedAt || category?.purgingAt
      ) {
        throw new AdminError("Archived categories are read-only.", 409);
      }
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
    const operation = this.store.kv.atomic().check(entry, threadEntry);
    if (categoryEntry) operation.check(categoryEntry);
    if (!(await operation.set(entry.key, updated).commit()).ok) {
      throw new AdminError(
        "Message or conversation changed. Reload and retry.",
        409,
      );
    }
    const thread = await this.store.getThread(message.threadId);
    if (thread) this.publish(thread);
    return updated;
  }
  async deleteMessage(id: string) {
    const entry = await this.store.kv.get<Message>(["message", id]);
    const message = required(entry.value);
    const threadEntry = await this.store.kv.get<Thread>([
      "thread",
      message.threadId,
    ]);
    const thread = required(threadEntry.value, "Conversation not found.");
    if (thread.archivedAt || thread.deletedAt || thread.purgingAt) {
      throw new AdminError(
        "Messages in archived conversations can be permanently removed.",
        409,
      );
    }
    const categoryEntry = thread.categoryId
      ? await this.store.kv.get<
        { archivedAt: string | null; deletedAt?: string; purgingAt?: string }
      >([
        "category",
        thread.categoryId,
      ])
      : null;
    if (
      categoryEntry?.value?.archivedAt || categoryEntry?.value?.deletedAt ||
      categoryEntry?.value?.purgingAt
    ) {
      throw new AdminError(
        "Messages in archived categories can be permanently removed.",
        409,
      );
    }
    const operation = this.store.kv.atomic().check(entry, threadEntry);
    if (categoryEntry) operation.check(categoryEntry);
    if (
      !(await operation.set(entry.key, {
        ...message,
        text: "",
        mentions: [],
        deletedAt: new Date().toISOString(),
      }).commit()).ok
    ) {
      throw new AdminError(
        "Message or conversation changed. Reload and retry.",
        409,
      );
    }
    const currentThread = await this.store.getThread(message.threadId);
    if (currentThread) this.publish(currentThread);
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
