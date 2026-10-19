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

const password = "correct horse battery staple";

async function countKeyPrefix(kv: Deno.Kv, prefix: Deno.KvKey) {
  let count = 0;
  for await (const _entry of kv.list({ prefix })) count++;
  return count;
}

Deno.test("thread followers receive one reply notification each; unfollow stops them", async () => {
  await withStore(async (store) => {
    const author = session("follow-author");
    const follower = session("follow-follower");
    const mentioned = session("follow-mentioned");
    const outsider = session("follow-outsider");
    for (
      const [current, username] of [
        [author, "follow_author"],
        [follower, "follow_follower"],
        [mentioned, "follow_mentioned"],
        [outsider, "follow_outsider"],
      ] as const
    ) {
      await store.authenticate(current, username, password);
    }
    const category = await store.createCategory(author, "Follow");
    const thread = await store.postThread(author, category.id, "Kickoff");
    // The author follows the thread they started.
    assertEquals(
      (await store.followThread(follower, thread.thread.id)).followers,
      2,
    );

    await store.reply(author, thread.thread.id, "Update for everyone");
    const followerInbox = await store.listInbox(follower);
    assertEquals(followerInbox.items.map((item) => item.kind), ["reply"]);
    assertEquals(followerInbox.items[0].threadId, thread.thread.id);
    assertEquals((await store.listInbox(author)).items.length, 0);

    // A reply that mentions a follower notifies once, as a mention.
    await store.reply(
      author,
      thread.thread.id,
      "@follow_follower and @follow_mentioned",
    );
    assertEquals(
      (await store.listInbox(follower)).items.map((item) => item.kind),
      ["reply", "mention"],
    );
    assertEquals(
      (await store.listInbox(mentioned)).items.map((item) => item.kind),
      ["mention"],
    );

    // Replying follows the thread, so the outsider is notified from now on.
    const outsiderReply = await store.reply(
      outsider,
      thread.thread.id,
      "Joining in",
    );
    const authorInbox = await store.listInbox(author);
    assertEquals(authorInbox.items.map((item) => item.kind), ["reply"]);
    assertEquals(authorInbox.items[0].messageId, outsiderReply.id);
    assertEquals(
      (await store.followThread(outsider, thread.thread.id)).followers,
      3,
    );

    assertEquals(
      (await store.unfollowThread(follower, thread.thread.id)).following,
      false,
    );
    await store.reply(outsider, thread.thread.id, "After the unfollow");
    // The reply and mention entries stay; the reply after the unfollow adds none.
    assertEquals((await store.listInbox(follower)).items.length, 3);
    assertEquals((await store.listInbox(author)).items.length, 2);
  });
});

Deno.test("a full follower index rejects new follows and still commits one reply fan-out", async () => {
  await withStore(async (store) => {
    const author = session("cap-author");
    const replier = session("cap-replier");
    await store.authenticate(author, "cap_author", password);
    await store.authenticate(replier, "cap_replier", password);
    const category = await store.createCategory(author, "Cap");
    const thread = await store.postThread(author, category.id, "Crowded");
    // The author plus 99 seeded accounts fill the index without hashing 100 passwords.
    await Promise.all(
      Array.from({ length: 99 }, (_unused, index) => {
        const accountId = `seeded-${index}`;
        return [
          store.kv.set(["follow", accountId, thread.thread.id], {
            accountId,
            threadId: thread.thread.id,
            createdAt: "seeded",
          }),
          store.kv.set(["thread-follower", thread.thread.id, accountId], true),
        ];
      }).flat(),
    );

    await assertRejects(
      () => store.followThread(replier, thread.thread.id),
      Error,
      "maximum of 100 followers",
    );
    await store.reply(replier, thread.thread.id, "No room left");
    // Fan-out to 100 followers commits, and the full index skips auto-follow.
    assertEquals(await countKeyPrefix(store.kv, ["inbox"]), 100);
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 100);
    assertEquals(await countKeyPrefix(store.kv, ["follow"]), 100);
  });
});

Deno.test("idempotency keys replay one write instead of repeating it", async () => {
  await withStore(async (store) => {
    const alice = session("idem-alice");
    const bob = session("idem-bob");
    const anon = session("idem-anon");
    await store.authenticate(alice, "idem_alice", password);
    await store.authenticate(bob, "idem_bob", password);
    const category = await store.createCategory(alice, "Retries");

    const first = await store.postThread(alice, category.id, "Retry me", {
      idempotencyKey: "post-1",
    });
    const retried = await store.postThread(alice, category.id, "Retry me", {
      idempotencyKey: "post-1",
    });
    assertEquals(retried.thread.id, first.thread.id);
    assertEquals(retried.message.id, first.message.id);
    assertEquals(
      (await store.listMessages(alice, first.thread.id)).items.length,
      1,
    );

    // The same account from another session replays; another caller does not.
    const aliceAgain = session("idem-alice-again");
    await store.authenticate(aliceAgain, "idem_alice", password);
    const replayedAcrossSessions = await store.postThread(
      aliceAgain,
      category.id,
      "Retry me",
      { idempotencyKey: "post-1" },
    );
    assertEquals(replayedAcrossSessions.message.id, first.message.id);
    const anonymousPost = await store.postThread(
      anon,
      category.id,
      "Retry me",
      {
        idempotencyKey: "post-1",
      },
    );
    assert(anonymousPost.message.id !== first.message.id);

    await assertRejects(
      () =>
        store.postThread(alice, category.id, "Different text", {
          idempotencyKey: "post-1",
        }),
      Error,
      "already used for a different write",
    );
    assertEquals(
      await countKeyPrefix(store.kv, ["message"]),
      2,
      "a rejected reuse and a replay must not write a message",
    );

    const reply = await store.reply(alice, first.thread.id, "Reply once", {
      idempotencyKey: "reply-1",
    });
    const replyRetried = await store.reply(
      alice,
      first.thread.id,
      "Reply once",
      {
        idempotencyKey: "reply-1",
      },
    );
    assertEquals(replyRetried.id, reply.id);
    assertEquals(
      (await store.listMessages(alice, first.thread.id)).items.length,
      2,
    );

    const dm = await store.sendDm(alice, "idem_bob", "Private retry", {
      idempotencyKey: "dm-1",
    });
    const dmRetried = await store.sendDm(alice, "idem_bob", "Private retry", {
      idempotencyKey: "dm-1",
    });
    assertEquals(dmRetried.threadId, dm.threadId);
    assertEquals(dmRetried.message.id, dm.message.id);
    assertEquals(dmRetried.created, true);
    assertEquals((await store.listMessages(bob, dm.threadId)).items.length, 1);
    assertEquals(await countKeyPrefix(store.kv, ["inbox"]), 1);
  });
});
