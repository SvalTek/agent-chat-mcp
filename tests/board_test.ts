import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { BoardStore, type SessionIdentity } from "../src/domain/board.ts";

async function withStore<T>(run: (store: BoardStore) => Promise<T>) {
  const directory = await Deno.makeTempDir({ prefix: "agent-chat-test-" });
  const store = await BoardStore.open(join(directory, "board.kv"));
  try {
    return await run(store);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function session(id: string): SessionIdentity {
  return { id, accountId: null, lastMessageId: null };
}

Deno.test("atomic username reservation rejects a competing password", async () => {
  await withStore(async (store) => {
    const first = session("first");
    const second = session("second");
    const results = await Promise.allSettled([
      store.authenticate(first, "SharedName", "correct horse battery staple"),
      store.authenticate(second, "sharedname", "another correct horse"),
    ]);
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const winner = results.find((result) => result.status === "fulfilled")!;
    assertEquals(winner.status, "fulfilled");
    assert(winner.value.registered);
  });
});

Deno.test("public posting, anonymous edit boundary, and category creator access", async () => {
  await withStore(async (store) => {
    const owner = session("owner");
    await store.authenticate(
      owner,
      "category_owner",
      "correct horse battery staple",
    );
    const category = await store.createCategory(owner, "Research");
    const threadResult = await store.postThread(
      session("anon-a"),
      category.id,
      "first anonymous post",
    );
    const anonA = session("anon-a");
    // The post must be created by the same session object to retain its edit handle.
    const ownThread = await store.postThread(
      anonA,
      category.id,
      "second anonymous post",
    );
    await assertRejects(() =>
      store.editMessage(anonA, threadResult.message.id, "wrong post")
    );
    await store.editMessage(anonA, ownThread.message.id, "corrected post");
    const anonB = session("anon-b");
    await assertRejects(() =>
      store.editMessage(anonB, ownThread.message.id, "not yours")
    );
    const renamed = await store.renameCategory(
      owner,
      category.id,
      "Updated Research",
    );
    assertEquals(renamed.creatorAccountId, owner.accountId);
    await store.archiveCategory(owner, category.id);
    await assertRejects(() =>
      store.postThread(session("anon-c"), category.id, "archived")
    );
  });
});

Deno.test("mentions, private DMs, and cursor-based inbox acknowledgment", async () => {
  await withStore(async (store) => {
    const alice = session("alice-session");
    const bob = session("bob-session");
    await store.authenticate(
      alice,
      "alice_agent",
      "correct horse battery staple",
    );
    await store.authenticate(bob, "bob_agent", "correct horse battery staple");
    const category = await store.createCategory(alice, "Coordination");
    await store.postThread(alice, category.id, "Hi @bob_agent");
    const bobInbox = await store.listInbox(bob);
    assertEquals(bobInbox.items.length, 1);
    assertEquals(bobInbox.items[0].kind, "mention");

    const dm = await store.sendDm(alice, "bob_agent", "private note");
    assertEquals(
      (await store.listMessages(alice, dm.threadId)).items.length,
      1,
    );
    await assertRejects(() =>
      store.listMessages(session("outsider"), dm.threadId)
    );

    const beforeNewMessage = bobInbox.items[0].readCursor;
    await store.sendDm(alice, "bob_agent", "arrived after the cursor");
    await store.markInboxRead(bob, beforeNewMessage);
    const afterAck = await store.listInbox(bob);
    assertEquals(afterAck.items.filter((item) => item.read).length, 1);
    assertEquals(afterAck.items.filter((item) => !item.read).length, 2);
  });
});

Deno.test("failed atomic commits leave no message/index writes or emitted events", async () => {
  await withStore(async (store) => {
    const owner = session("owner");
    await store.authenticate(
      owner,
      "failure_owner",
      "correct horse battery staple",
    );
    const category = await store.createCategory(owner, "Atomic");
    const events: unknown[] = [];
    const unsubscribe = store.events.subscribe((event) => events.push(event));
    const original = store.kv.atomic.bind(store.kv);
    store.kv.atomic = () => {
      const op = original();
      op.commit = () => Promise.resolve({ ok: false });
      return op;
    };
    try {
      await assertRejects(() =>
        store.postThread(owner, category.id, "Must not persist")
      );
      await assertRejects(() =>
        store.createCategory(owner, "Must not publish")
      );
      assertEquals(events.length, 0);
    } finally {
      store.kv.atomic = original;
      unsubscribe();
    }
    assertEquals((await store.listThreads(category.id)).items.length, 0);
    assertEquals((await store.listCategories()).items.length, 1);
    const messages = [];
    for await (const entry of store.kv.list({ prefix: ["message"] })) {
      messages.push(entry);
    }
    assertEquals(messages.length, 0);
  });
});
Deno.test("anonymous identity survives request objects; pagination and edited mentions retain account read state", async () => {
  await withStore(async (store) => {
    const owner = session("owner"), reader = session("reader");
    await store.authenticate(
      owner,
      "edit_owner",
      "correct horse battery staple",
    );
    await store.authenticate(
      reader,
      "edit_reader",
      "correct horse battery staple",
    );
    const category = await store.createCategory(owner, "Work");
    const first = await store.postThread(
      session("anonymous"),
      category.id,
      "First",
    );
    await store.editMessage(
      session("anonymous"),
      first.message.id,
      "Corrected across requests",
    );
    const reply = await store.reply(
      session("anonymous"),
      first.thread.id,
      "Latest",
    );
    await assertRejects(() =>
      store.editMessage(session("anonymous"), first.message.id, "Too old")
    );
    await store.editMessage(session("anonymous"), reply.id, "Corrected latest");
    const page = await store.listMessages(owner, first.thread.id, { limit: 1 });
    assert(page.nextCursor);
    await store.reply(owner, first.thread.id, "Concurrent insertion");
    const continuation = await store.listMessages(owner, first.thread.id, {
      limit: 100,
      cursor: page.nextCursor,
    });
    assertEquals(continuation.items.length, 2);
    assert(!continuation.items.some((m) => m.id === page.items[0].id));
    const own = await store.postThread(
      owner,
      category.id,
      "No mention initially",
    );
    await store.editMessage(owner, own.message.id, "Hello @EDIT_READER");
    const inbox = await store.listInbox(reader);
    assertEquals(inbox.items.length, 1);
    await store.markInboxRead(reader, inbox.items[0].readCursor);
    const laterSession = session("reader-next-session");
    await store.authenticate(
      laterSession,
      "edit_reader",
      "correct horse battery staple",
    );
    assert((await store.listInbox(laterSession)).items[0].read);
    await store.archiveCategory(owner, category.id);
    await assertRejects(() =>
      store.editMessage(owner, own.message.id, "Archived edit")
    );
  });
});
