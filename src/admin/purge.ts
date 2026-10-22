import type { BoardStore, Message, Thread } from "../domain/board.ts";
import { AdminError, required } from "./errors.ts";

export async function deleteMatching<T>(
  kv: Deno.Kv,
  prefix: Deno.KvKey,
  matches: (value: T, key: Deno.KvKey) => boolean = () => true,
) {
  let cursor: string | undefined;
  for (;;) {
    const iterator = kv.list<T>({ prefix }, {
      limit: 400,
      ...(cursor ? { cursor } : {}),
    });
    const keys: Deno.KvKey[] = [];
    for await (const entry of iterator) {
      if (matches(entry.value, entry.key)) keys.push(entry.key);
    }
    const next = iterator.cursor;
    if (keys.length) {
      const operation = kv.atomic();
      for (const key of keys) operation.delete(key);
      if (!(await operation.commit()).ok) {
        throw new AdminError("Storage changed during purge. Retry.", 409);
      }
    }
    if (!next || next === cursor) break;
    cursor = next;
  }
}

function isArchived(thread: Thread, categoryArchived: boolean) {
  return Boolean(
    thread.archivedAt || thread.deletedAt || thread.purgingAt ||
      categoryArchived,
  );
}

export async function purgeConversation(store: BoardStore, id: string) {
  const kv = store.kv;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await kv.get<Thread>(["thread", id]);
    const thread = required(entry.value, "Conversation not found.");
    const category = thread.categoryId
      ? (await kv.get<{
        archivedAt: string | null;
        deletedAt?: string;
        purgingAt?: string;
      }>([
        "category",
        thread.categoryId,
      ])).value
      : null;
    if (
      !isArchived(
        thread,
        Boolean(
          category?.archivedAt || category?.deletedAt || category?.purgingAt,
        ),
      )
    ) {
      throw new AdminError("Archive the conversation before purging it.", 409);
    }
    if (!thread.purgingAt) {
      const result = await kv.atomic().check(entry).set(entry.key, {
        ...thread,
        purgingAt: new Date().toISOString(),
      }).commit();
      if (!result.ok) continue;
    }
    break;
  }

  const current = required(
    (await kv.get<Thread>(["thread", id])).value,
    "Conversation not found.",
  );
  if (!current.purgingAt) {
    throw new AdminError("Conversation changed during purge. Retry.", 409);
  }
  const messageIds = new Set<string>();
  const affectedAccounts = new Set(current.participants);
  for await (
    const entry of kv.list<string>({ prefix: ["thread-message", id] })
  ) {
    messageIds.add(entry.value);
  }
  await deleteMatching<string>(
    kv,
    ["session-last-message"],
    (messageId) => messageIds.has(messageId),
  );
  await deleteMatching<{ threadId?: string }>(
    kv,
    ["idem"],
    (value) => value.threadId === id,
  );
  await deleteMatching(
    kv,
    ["feed"],
    (value: { threadId?: string }) => value.threadId === id,
  );
  await deleteMatching(
    kv,
    ["inbox"],
    (value: { threadId?: string }, key) => {
      if (value.threadId !== id) return false;
      if (typeof key[1] === "string") affectedAccounts.add(key[1]);
      return true;
    },
  );
  if (current.categoryId) {
    await deleteMatching<string>(
      kv,
      ["category-thread", current.categoryId],
      (threadId) => threadId === id,
    );
  }
  const followers: string[] = [];
  for await (const entry of kv.list({ prefix: ["thread-follower", id] })) {
    followers.push(String(entry.key.at(-1)));
  }
  for (const accountId of followers) affectedAccounts.add(accountId);
  await deleteMatching(kv, ["thread-follower", id]);
  await deleteMatching(kv, ["follow"], (_value, key) => key[2] === id);
  await kv.delete(["thread-follower-count", id]);
  if (current.kind === "dm") {
    const pairKey = ["dm-pair", ...current.participants.slice().sort()];
    const pair = await kv.get<string>(pairKey);
    if (pair.value === id) await kv.delete(pairKey);
  }
  await deleteMatching<string>(kv, ["thread-message", id]);
  await deleteMatching<Message>(kv, ["message"], (message) => {
    if (message.threadId !== id) return false;
    messageIds.add(message.id);
    return true;
  });
  store.events.publish({
    publicUris: current.kind === "public"
      ? [
        "agent-chat://categories",
        "agent-chat://feed",
        `agent-chat://threads/${id}`,
        ...(current.categoryId
          ? [`agent-chat://categories/${current.categoryId}/threads`]
          : []),
      ]
      : [],
    accountUris: Object.fromEntries(
      [...affectedAccounts].map((accountId) => [accountId, [
        ...(current.kind === "dm" ? [`agent-chat://dms/${id}`] : []),
        "agent-chat://inbox/me",
      ]]),
    ),
  });
  await kv.delete(["thread", id]);
  return { deleted: true, messages: messageIds.size };
}

export async function purgeMessage(store: BoardStore, id: string) {
  const kv = store.kv;
  const entry = await kv.get<Message>(["message", id]);
  const message = required(entry.value, "Message not found.");
  const thread = (await kv.get<Thread>(["thread", message.threadId])).value;
  const category = thread?.categoryId
    ? (await kv.get<{
      archivedAt: string | null;
      deletedAt?: string;
      purgingAt?: string;
    }>([
      "category",
      thread.categoryId,
    ])).value
    : null;
  if (
    !thread ||
    !isArchived(
      thread,
      Boolean(
        category?.archivedAt || category?.deletedAt || category?.purgingAt,
      ),
    )
  ) {
    throw new AdminError(
      "Archive the conversation before purging messages.",
      409,
    );
  }
  const affectedAccounts = new Set<string>();
  await deleteMatching<string>(
    kv,
    ["thread-message", message.threadId],
    (messageId) => messageId === id,
  );
  await deleteMatching(
    kv,
    ["feed"],
    (value: { messageId?: string }) => value.messageId === id,
  );
  await deleteMatching(
    kv,
    ["inbox"],
    (value: { messageId?: string }, key) => {
      if (value.messageId !== id) return false;
      if (typeof key[1] === "string") affectedAccounts.add(key[1]);
      return true;
    },
  );
  await deleteMatching<string>(
    kv,
    ["session-last-message"],
    (value) => value === id,
  );
  await deleteMatching<{ messageId?: string }>(
    kv,
    ["idem"],
    (value) => value.messageId === id,
  );
  store.events.publish({
    publicUris: thread.kind === "public"
      ? ["agent-chat://feed", `agent-chat://threads/${thread.id}`]
      : [],
    accountUris: Object.fromEntries(
      [...affectedAccounts, ...thread.participants].map((accountId) => [
        accountId,
        [
          ...(thread.kind === "dm" ? [`agent-chat://dms/${thread.id}`] : []),
          "agent-chat://inbox/me",
        ],
      ]),
    ),
  });
  await kv.delete(entry.key);
  return { deleted: true };
}

export async function purgeCategory(store: BoardStore, id: string) {
  const kv = store.kv;
  const entry = await kv.get<{
    archivedAt: string | null;
    createdAt: string;
    deletedAt?: string;
    id: string;
    purgingAt?: string;
  }>(["category", id]);
  const category = required(entry.value, "Category not found.");
  if (!category.archivedAt && !category.deletedAt && !category.purgingAt) {
    throw new AdminError("Archive the category before purging it.", 409);
  }
  if (!category.purgingAt) {
    const result = await kv.atomic().check(entry).set(entry.key, {
      ...category,
      purgingAt: new Date().toISOString(),
    }).commit();
    if (!result.ok) throw new AdminError("Category changed. Retry.", 409);
  }
  const threadIds: string[] = [];
  for await (const thread of kv.list<Thread>({ prefix: ["thread"] })) {
    if (thread.value.categoryId === id) threadIds.push(thread.value.id);
  }
  for (const threadId of threadIds) await purgeConversation(store, threadId);
  await deleteMatching(kv, ["category-thread", id]);
  await kv.delete(["category-list", category.createdAt, id]);
  const latest = await kv.get(["category", id]);
  if (
    !(await kv.atomic().check(latest).delete(["category", id]).commit()).ok
  ) throw new AdminError("Category changed during purge. Retry.", 409);
  store.events.publish({
    publicUris: ["agent-chat://categories", "agent-chat://feed"],
    accountUris: {},
  });
  return { deleted: true, conversations: threadIds.length };
}
