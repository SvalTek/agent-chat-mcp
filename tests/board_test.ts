import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  BoardStore,
  type Category,
  type SessionIdentity,
  type Thread,
} from "../src/domain/board.ts";
import { backfillFeed } from "../src/domain/feed.ts";
import { getLogs } from "../src/infra/logs.ts";

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

Deno.test("profiles update under a version check and stay out of mention payloads", async () => {
  await withStore(async (store) => {
    const author = session("profile-author");
    const anonymous = session("profile-anonymous");
    await store.authenticate(author, "profile_author", password);
    const account = (await store.getAccount(author.accountId!))!;
    const saved = await store.updateProfile(
      author,
      "  Coordinates the release train.  ",
    );
    assertEquals(saved, {
      id: account.id,
      username: "profile_author",
      description: "Coordinates the release train.",
      createdAt: account.createdAt,
    });
    assertEquals(
      (await store.getAccount(author.accountId!))!.description,
      "Coordinates the release train.",
    );
    await assertRejects(
      () => store.updateProfile(author, "x".repeat(501)),
      Error,
      "limited to 500 characters",
    );
    assertEquals(
      (await store.updateProfile(author, "   ")).description,
      null,
      "an empty description clears the profile",
    );
    assertEquals(
      (await store.getAccount(author.accountId!))!.description,
      undefined,
    );
    await assertRejects(
      () => store.updateProfile(anonymous, "not signed in"),
      Error,
      "Authenticate first",
    );
    // Mention resolution stays two fields so every message stays small.
    assertEquals(await store.resolveUsername("profile_author"), {
      id: author.accountId,
      username: "profile_author",
    });
  });
});

Deno.test("the agent directory lists profiles and hides suspended accounts", async () => {
  await withStore(async (store) => {
    const author = session("directory-author");
    const peer = session("directory-peer");
    await store.authenticate(author, "directory_author", password);
    await store.authenticate(peer, "directory_peer", password);
    await store.updateProfile(author, "Owns the release train.");

    const page = await store.listAgents();
    assertEquals(
      page.items.map((item) => item.username).sort(),
      ["directory_author", "directory_peer"],
    );
    assertEquals(
      page.items.map((item) => [item.username, item.description]).sort(),
      [
        ["directory_author", "Owns the release train."],
        ["directory_peer", null],
      ],
    );
    const profile = await store.getAgent(author.accountId!);
    assertEquals(profile, {
      id: (await store.getAccount(author.accountId!))!.id,
      username: "directory_author",
      description: "Owns the release train.",
      createdAt: (await store.getAccount(author.accountId!))!.createdAt,
    });
    assertEquals(await store.getAgent(crypto.randomUUID()), null);

    const firstPage = await store.listAgents({ limit: 1 });
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor);
    const secondPage = await store.listAgents({
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assertEquals(secondPage.items.length, 1);
    assert(secondPage.items[0].id !== firstPage.items[0].id);

    // A suspended account is neither listed nor readable.
    const account = (await store.getAccount(peer.accountId!))!;
    await store.kv.set(["account", peer.accountId!], {
      ...account,
      suspendedAt: new Date().toISOString(),
    });
    assertEquals(
      (await store.listAgents()).items.map((item) => item.username),
      ["directory_author"],
    );
    assertEquals(await store.getAgent(peer.accountId!), null);
    await assertRejects(
      () => store.authenticate(peer, "directory_peer", password),
      Error,
    );
  });
});

Deno.test("board search stays inside its scope, newest first, and never leaks DMs", async () => {
  await withStore(async (store) => {
    const author = session("search-author");
    const peer = session("search-peer");
    const anonymous = session("search-anonymous");
    await store.authenticate(author, "search_author", password);
    await store.authenticate(peer, "search_peer", password);
    const coordination = await store.createCategory(author, "Coordination");
    const social = await store.createCategory(author, "Social");
    const thread = await store.postThread(
      author,
      coordination.id,
      "Rollout checklist ready",
    );
    await store.reply(peer, thread.thread.id, "Checklist reviewed");
    await store.postThread(author, social.id, "Lunch plans");
    const dm = await store.sendDm(
      author,
      "search_peer",
      "Checklist is private",
    );

    const board = await store.search(author, { query: "checklist" });
    assertEquals(
      board.items.map((item) => item.message.text),
      ["Checklist reviewed", "Rollout checklist ready"],
    );
    assertEquals(
      board.items.map((item) => item.categoryId),
      [coordination.id, coordination.id],
    );
    assertEquals(board.scanned, 3, "the DM message is not a board candidate");
    assertEquals(board.truncated, false);
    assertEquals(board.scanLimit, 1000);

    const inCategory = await store.search(author, {
      query: "checklist",
      categoryId: coordination.id,
    });
    assertEquals(inCategory.items.length, 2);
    assertEquals(
      (await store.search(author, {
        query: "checklist",
        categoryId: social.id,
      }))
        .items.length,
      0,
    );

    const inThread = await store.search(peer, {
      query: "CHECKLIST",
      threadId: thread.thread.id,
    });
    assertEquals(
      inThread.items.map((item) => item.message.text),
      ["Checklist reviewed", "Rollout checklist ready"],
      "matching is case-insensitive",
    );

    const firstMatchOnly = await store.search(author, {
      query: "checklist",
      limit: 1,
    });
    assertEquals(
      firstMatchOnly.items.map((item) => item.message.text),
      ["Checklist reviewed"],
    );
    assertEquals(
      firstMatchOnly.scanned,
      2,
      "the scan stops once the page is full",
    );

    assertEquals(
      (await store.search(peer, { query: "private" })).items.length,
      0,
    );
    assertEquals(
      (
        await store.search(peer, { query: "private", threadId: dm.threadId })
      ).items.map((item) => item.message.text),
      ["Checklist is private"],
    );
    await assertRejects(
      () =>
        store.search(anonymous, { query: "private", threadId: dm.threadId }),
      Error,
      "Private conversation unavailable",
    );
    await assertRejects(
      () =>
        store.search(anonymous, {
          query: "x",
          categoryId: coordination.id,
          threadId: thread.thread.id,
        }),
      Error,
      "one thread or one category",
    );
    await assertRejects(
      () => store.search(author, { query: " " }),
      Error,
      "Enter a search query",
    );
    await assertRejects(
      () =>
        store.search(author, { query: "x", categoryId: crypto.randomUUID() }),
      Error,
      "Category not found",
    );
    await assertRejects(
      () => store.search(author, { query: "x", threadId: crypto.randomUUID() }),
      Error,
      "Thread not found",
    );
  });
});

Deno.test("board search stops at its scan window and reports the truncation", async () => {
  await withStore(async (store) => {
    const author = session("window-search-author");
    await store.authenticate(author, "window_search", password);
    const category = await store.createCategory(author, "Window");
    const thread = await store.postThread(
      author,
      category.id,
      "needle in the oldest message",
    );
    // Seeded stamps sort after real versionstamps, so a reverse scan meets them
    // first and they stand in for a long board history.
    const seedWindow = async (count: number) => {
      for (let start = 0; start < count; start += 100) {
        const op = store.kv.atomic();
        for (let index = start; index < Math.min(start + 100, count); index++) {
          op.set(["feed", `seed-${String(index).padStart(5, "0")}`], {
            messageId: crypto.randomUUID(),
            threadId: crypto.randomUUID(),
            categoryId: category.id,
          });
        }
        await op.commit();
      }
    };

    await seedWindow(999);
    const inside = await store.search(author, { query: "needle" });
    assertEquals(inside.items.map((item) => item.message.id), [
      thread.message.id,
    ]);
    assertEquals(inside.scanned, 1000);
    assertEquals(inside.truncated, false, "the index ended inside the window");

    await seedWindow(1000);
    const clipped = await store.search(author, { query: "needle" });
    assertEquals(
      clipped.items.length,
      0,
      "the oldest match is outside the window",
    );
    assertEquals(clipped.scanned, 1000);
    assertEquals(clipped.truncated, true);
  });
});

Deno.test("paging fills a page with live entries when newer ones resolve to null", async () => {
  await withStore(async (store) => {
    const author = session("page-author");
    const peer = session("page-peer");
    const third = session("page-third");
    await store.authenticate(author, "page_author", password);
    await store.authenticate(peer, "page_peer", password);
    await store.authenticate(third, "page_third", password);
    const category = await store.createCategory(author, "Paging");

    // The two newest feed entries resolve to null; a limit=1 page must keep
    // scanning to the live message rather than stopping on raw entries.
    const started = await store.postThread(author, category.id, "Oldest live");
    const deleted = [
      await store.reply(peer, started.thread.id, "Deleted middle"),
      await store.reply(peer, started.thread.id, "Deleted newest"),
    ];
    for (const message of deleted) {
      await store.kv.set(["message", message.id], {
        ...message,
        deletedAt: new Date().toISOString(),
      });
    }
    const feedPage = await store.listFeed({ limit: 1 });
    assertEquals(feedPage.items.map((item) => item.message.text), [
      "Oldest live",
    ]);
    assertEquals(feedPage.nextCursor, null);

    // Same for the directory: suspend the two accounts that sort first, then
    // page past them to the account that is still visible.
    const all = (await store.listAgents({ limit: 100 })).items;
    assertEquals(all.length, 3);
    const firstTwo = new Set(
      all.map((profile) => profile.id).sort().slice(0, 2),
    );
    for (const id of firstTwo) {
      const account = (await store.getAccount(id))!;
      await store.kv.set(["account", id], {
        ...account,
        suspendedAt: new Date().toISOString(),
      });
    }
    const directoryPage = await store.listAgents({ limit: 1 });
    assertEquals(directoryPage.items.length, 1);
    assertEquals(
      directoryPage.items[0].username,
      all.find((profile) => !firstTwo.has(profile.id))!.username,
    );
    assertEquals(directoryPage.nextCursor, null);
  });
});

Deno.test("category search counts only in-scope candidates toward its window", async () => {
  await withStore(async (store) => {
    const author = session("cat-window-author");
    await store.authenticate(author, "cat_window", password);
    const target = await store.createCategory(author, "Target");
    const noise = await store.createCategory(author, "Noise");
    const thread = await store.postThread(
      author,
      target.id,
      "needle in the target category",
    );
    // A busy neighbouring category must not crowd the in-scope window out.
    for (let start = 0; start < 1000; start += 100) {
      const op = store.kv.atomic();
      for (let index = start; index < Math.min(start + 100, 1000); index++) {
        op.set(["feed", `noise-${String(index).padStart(5, "0")}`], {
          messageId: crypto.randomUUID(),
          threadId: crypto.randomUUID(),
          categoryId: noise.id,
        });
      }
      await op.commit();
    }
    const found = await store.search(author, {
      query: "needle",
      categoryId: target.id,
    });
    assertEquals(found.items.map((item) => item.message.id), [
      thread.message.id,
    ]);
    assertEquals(found.scanned, 1);
    assertEquals(found.truncated, false);

    // Board scope still walks the board window and reports the cut-off.
    const board = await store.search(author, { query: "needle" });
    assertEquals(board.scanned, 1000);
    assertEquals(board.truncated, true);
  });
});

Deno.test("concurrent follows cannot take a thread past the follower cap", async () => {
  await withStore(async (store) => {
    const author = session("race-author");
    await store.authenticate(author, "race_author", password);
    const category = await store.createCategory(author, "Race");
    const thread = await store.postThread(author, category.id, "Contended");
    // The author's own auto-follow left one follower; seed to one short of the
    // cap, sharing the counter every follow path version-checks.
    await Promise.all(
      Array.from({ length: 98 }, (_unused, index) => {
        const accountId = `seeded-race-${index}`;
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
    await store.kv.set(["thread-follower-count", thread.thread.id], 99);

    const racers: SessionIdentity[] = [];
    for (let index = 0; index < 6; index++) {
      const racer = session(`race-racer-${index}`);
      await store.authenticate(racer, `race_racer_${index}`, password);
      racers.push(racer);
    }
    const results = await Promise.allSettled(
      racers.map((racer) => store.followThread(racer, thread.thread.id)),
    );
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "exactly one racer claims the last slot",
    );
    assertEquals(
      results.filter((result) =>
        result.status === "rejected" &&
        String(result.reason).includes("maximum of 100 followers")
      ).length,
      5,
    );

    // Every follower the cap admits is still reachable by a reply fan-out.
    const outsider = session("race-outsider");
    await store.authenticate(outsider, "race_outsider", password);
    await store.reply(outsider, thread.thread.id, "Fan out to all followers");
    assertEquals(await countKeyPrefix(store.kv, ["inbox"]), 100);
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 100);
  });
});

Deno.test("public writes and profile changes publish the views they change", async () => {
  await withStore(async (store) => {
    const author = session("events-author");
    const events: { publicUris: string[] }[] = [];
    const unsubscribe = store.events.subscribe((event) =>
      events.push(event as { publicUris: string[] })
    );
    try {
      const last = () => events[events.length - 1]?.publicUris ?? [];

      await store.authenticate(author, "events_author", password);
      assertEquals(last(), ["agent-chat://agents"]);

      // Signing in again changes nothing in the directory.
      const seen = events.length;
      await store.authenticate(author, "events_author", password);
      assertEquals(events.length, seen);

      const category = await store.createCategory(author, "Events");
      const started = await store.postThread(author, category.id, "First");
      assert(last().includes("agent-chat://feed"));

      const replied = await store.reply(author, started.thread.id, "Second");
      assert(last().includes("agent-chat://feed"));

      await store.editMessage(author, replied.id, "Second, edited");
      assert(last().includes("agent-chat://feed"));

      await store.updateProfile(author, "Describes the agent");
      assertEquals(last(), [
        "agent-chat://agents",
        `agent-chat://agents/${author.accountId}`,
      ]);

      // A DM edit is private, so it must not signal the public feed.
      const peer = session("events-peer");
      await store.authenticate(peer, "events_peer", password);
      const dm = await store.sendDm(author, "events_peer", "Private");
      await store.editMessage(author, dm.message.id, "Private, edited");
      assertEquals(last(), []);
    } finally {
      unsubscribe();
    }
  });
});

Deno.test("paging stops at a scan budget and resumes past dropped entries", async () => {
  await withStore(async (store) => {
    const author = session("budget-author");
    await store.authenticate(author, "budget_author", password);
    const category = await store.createCategory(author, "Budget");
    const thread = await store.postThread(
      author,
      category.id,
      "Oldest live message",
    );
    // Feed entries newer than the live message, all pointing at message ids that
    // do not exist, so every one of them resolves to null.
    for (let start = 0; start < 100; start += 50) {
      const op = store.kv.atomic();
      for (let index = start; index < start + 50; index++) {
        op.set(["feed", `dropped-${String(index).padStart(5, "0")}`], {
          messageId: crypto.randomUUID(),
          threadId: crypto.randomUUID(),
          categoryId: category.id,
        });
      }
      await op.commit();
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.listFeed({
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      collected.push(...page.items.map((item) => item.message.text));
      cursor = page.nextCursor;
      assert(pages <= 6, "one request must not scan the whole run");
    } while (cursor);

    assertEquals(collected, ["Oldest live message"]);
    assert(pages >= 2, "the scan budget must split this run across requests");
    assertEquals(
      (await store.listFeed({ limit: 1 })).nextCursor !== null,
      true,
    );
    // A single request is bounded too: an empty page with a cursor is expected,
    // and walking the cursor is what reaches everything.
    const seen: string[] = [];
    let walk: string | null = null;
    let walkPages = 0;
    do {
      const page = await store.listFeed({
        limit: 10,
        ...(walk ? { cursor: walk } : {}),
      });
      walkPages++;
      seen.push(...page.items.map((item) => item.message.text));
      walk = page.nextCursor;
    } while (walk);
    assertEquals(seen, ["Oldest live message"]);
    assert(walkPages >= 2, "a bounded page may come back empty with a cursor");
    assertEquals(thread.message.text, "Oldest live message");
  });
});

Deno.test("a follower fault after a committed message is logged, not reported", async () => {
  await withStore(async (store) => {
    const author = session("resilient-author");
    await store.authenticate(author, "resilient_author", password);
    const category = await store.createCategory(author, "Resilient");
    const original = store.kv.list.bind(store.kv);
    store.kv.list = () => {
      throw new Error("simulated list failure");
    };
    let started: { thread: { id: string }; message: { id: string } };
    try {
      // Auto-follow reads the follower index; the post must survive that fault.
      started = await store.postThread(author, category.id, "Posted anyway");
    } finally {
      store.kv.list = original;
    }
    assertEquals(
      (await store.listMessages(author, started.thread.id)).items.map((
        item,
      ) => item.text),
      ["Posted anyway"],
    );
    assert(
      getLogs({ level: "warn" }).some((entry) =>
        entry.source === "follows:auto-follow" &&
        entry.message.includes("simulated list failure")
      ),
      "the swallowed fault must stay visible as a diagnostic",
    );
  });
});

Deno.test("unfollow still removes the follow when its version checks keep losing", async () => {
  await withStore(async (store) => {
    const author = session("stubborn-author");
    const peer = session("stubborn-peer");
    await store.authenticate(author, "stubborn_author", password);
    await store.authenticate(peer, "stubborn_peer", password);
    const category = await store.createCategory(author, "Stubborn");
    const thread = await store.postThread(author, category.id, "Thread");
    assertEquals(
      (await store.followThread(peer, thread.thread.id)).followers,
      2,
    );
    const countKey = ["thread-follower-count", thread.thread.id];
    assertEquals((await store.kv.get<number>(countKey)).value, 2);

    // Every version-checked commit loses, so unfollow reaches its fallback.
    const original = store.kv.atomic.bind(store.kv);
    let failures = 5;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = () =>
        failures-- > 0 ? Promise.resolve({ ok: false }) : commit();
      return op;
    };
    let result: { following: boolean; followers: number };
    try {
      result = await store.unfollowThread(peer, thread.thread.id);
    } finally {
      store.kv.atomic = original;
    }
    assertEquals(result.following, false);
    assertEquals(result.followers, 1);
    // The fallback must not leave the counter inflated, or the thread would
    // reject a new follower for good.
    assertEquals((await store.kv.get<number>(countKey)).value, 1);
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 1);
    assertEquals(await countKeyPrefix(store.kv, ["follow"]), 1);
    const replacement = session("stubborn-replacement");
    await store.authenticate(replacement, "stubborn_replacement", password);
    assertEquals(
      (await store.followThread(replacement, thread.thread.id)).followers,
      2,
    );
  });
});

Deno.test("an inflated follower counter cannot burn a follower slot", async () => {
  await withStore(async (store) => {
    const author = session("inflated-author");
    const peer = session("inflated-peer");
    await store.authenticate(author, "inflated_author", password);
    await store.authenticate(peer, "inflated_peer", password);
    const category = await store.createCategory(author, "Inflated");
    const thread = await store.postThread(author, category.id, "Thread");
    // A lost decrement leaves the stored counter claiming the cap while the
    // index holds one follower. The index is the truth, so a follow still fits.
    await store.kv.set(["thread-follower-count", thread.thread.id], 100);
    assertEquals(
      (await store.followThread(peer, thread.thread.id)).followers,
      2,
      "the follower index decides the total",
    );
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 2);
  });
});

Deno.test("a reply rebuilds its follower snapshot when the index moves", async () => {
  await withStore(async (store) => {
    const author = session("snapshot-author");
    const peer = session("snapshot-peer");
    const follower = session("snapshot-follower");
    await store.authenticate(author, "snapshot_author", password);
    await store.authenticate(peer, "snapshot_peer", password);
    await store.authenticate(follower, "snapshot_follower", password);
    const category = await store.createCategory(author, "Snapshot");
    const thread = await store.postThread(author, category.id, "Thread");
    await store.followThread(follower, thread.thread.id);

    // The first commit loses, which is what a follower change during the scan
    // looks like to the guarded commit.
    const original = store.kv.atomic.bind(store.kv);
    let failures = 1;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = () =>
        failures-- > 0 ? Promise.resolve({ ok: false }) : commit();
      return op;
    };
    let reply: { id: string };
    try {
      reply = await store.reply(peer, thread.thread.id, "Notified anyway");
    } finally {
      store.kv.atomic = original;
    }

    // The retry published the message exactly once and still notified the
    // follower the rebuilt snapshot found.
    const messages = await store.listMessages(peer, thread.thread.id);
    assertEquals(messages.items.map((item) => item.text), [
      "Thread",
      "Notified anyway",
    ]);
    const inbox = await store.listInbox(follower);
    assertEquals(inbox.items.map((item) => item.kind), ["reply"]);
    assertEquals(inbox.items[0].messageId, reply.id);
  });
});

Deno.test("a guarded reply retries even when no inbox entry is written", async () => {
  await withStore(async (store) => {
    const author = session("lonely-author");
    await store.authenticate(author, "lonely_author", password);
    const category = await store.createCategory(author, "Lonely");
    const thread = await store.postThread(author, category.id, "Thread");

    const original = store.kv.atomic.bind(store.kv);
    let failures = 1;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = () =>
        failures-- > 0 ? Promise.resolve({ ok: false }) : commit();
      return op;
    };
    let reply: { text: string };
    try {
      // The author is the only follower and mentions nobody, so the commit
      // checks the follower index while writing no inbox entry at all.
      reply = await store.reply(author, thread.thread.id, "Self reply");
    } finally {
      store.kv.atomic = original;
    }
    assertEquals(reply.text, "Self reply");
    assertEquals(
      (await store.listMessages(author, thread.thread.id)).items.map((item) =>
        item.text
      ),
      ["Thread", "Self reply"],
    );
  });
});

Deno.test("an idempotent replay respects a deleted category", async () => {
  await withStore(async (store) => {
    const author = session("replay-author");
    await store.authenticate(author, "replay_author", password);
    const category = await store.createCategory(author, "Replay");
    await store.postThread(author, category.id, "Replayed later", {
      idempotencyKey: "replay-1",
    });
    const entry = (await store.kv.get<Category>(["category", category.id]))
      .value!;
    await store.kv.set(["category", category.id], {
      ...entry,
      deletedAt: new Date().toISOString(),
    });
    // The replay resolves through the same visibility as every reader, so a
    // deleted category hides the write it would otherwise resurrect.
    await assertRejects(
      () =>
        store.postThread(author, category.id, "Replayed later", {
          idempotencyKey: "replay-1",
        }),
      Error,
      "no longer available",
    );
  });
});

Deno.test("a reply into a thread with no followers still retries", async () => {
  await withStore(async (store) => {
    const anonymous = session("empty-anonymous");
    const replier = session("empty-replier");
    await store.authenticate(replier, "empty_replier", password);
    const category = await store.createCategory(replier, "Empty");
    // An anonymous thread has no author follow, so the snapshot is empty and
    // the guarded commit writes no inbox entry at all.
    const thread = await store.postThread(
      anonymous,
      category.id,
      "Started anonymously",
    );
    assertEquals(
      (await store.listInbox(replier)).items.length,
      0,
      "no follower exists to notify yet",
    );

    const original = store.kv.atomic.bind(store.kv);
    let failures = 1;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = () =>
        failures-- > 0 ? Promise.resolve({ ok: false }) : commit();
      return op;
    };
    let reply: { text: string };
    try {
      reply = await store.reply(replier, thread.thread.id, "Into the void");
    } finally {
      store.kv.atomic = original;
    }
    assertEquals(reply.text, "Into the void");
    assertEquals(
      (await store.listMessages(replier, thread.thread.id)).items.map((item) =>
        item.text
      ),
      ["Started anonymously", "Into the void"],
    );
  });
});

Deno.test("a follow cannot outrun a category archived mid-flight", async () => {
  await withStore(async (store) => {
    const author = session("archive-race-author");
    const peer = session("archive-race-peer");
    await store.authenticate(author, "archive_race_author", password);
    await store.authenticate(peer, "archive_race_peer", password);
    const category = await store.createCategory(author, "Archive race");
    const thread = await store.postThread(author, category.id, "Thread");
    const categoryEntry = (await store.kv.get<Category>([
      "category",
      category.id,
    ])).value!;

    // The first commit archives the category and loses, which is what an owner
    // archiving between the follow's validation and its commit looks like.
    const original = store.kv.atomic.bind(store.kv);
    let armed = true;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = async () => {
        if (armed) {
          armed = false;
          await store.kv.set(["category", category.id], {
            ...categoryEntry,
            archivedAt: new Date().toISOString(),
          });
          return { ok: false };
        }
        return await commit();
      };
      return op;
    };
    let error: Error | null = null;
    try {
      await store.followThread(peer, thread.thread.id);
    } catch (caught) {
      error = caught as Error;
    } finally {
      store.kv.atomic = original;
    }
    assertEquals(
      error?.message,
      "This category is archived and read-only.",
      "an archived category must be reported, not silent success",
    );
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 1);
  });
});

Deno.test("a follow survives a thread renamed mid-flight", async () => {
  await withStore(async (store) => {
    const author = session("rename-race-author");
    const peer = session("rename-race-peer");
    await store.authenticate(author, "rename_race_author", password);
    await store.authenticate(peer, "rename_race_peer", password);
    const category = await store.createCategory(author, "Rename race");
    const thread = await store.postThread(author, category.id, "Thread");
    const threadEntry = (await store.kv.get<Thread>([
      "thread",
      thread.thread.id,
    ])).value!;

    // A benign mutation — an admin renaming the thread — bumps the version the
    // follow guarded on, while the thread stays perfectly followable.
    const original = store.kv.atomic.bind(store.kv);
    let armed = true;
    store.kv.atomic = () => {
      const op = original();
      const commit = op.commit.bind(op);
      op.commit = async () => {
        if (armed) {
          armed = false;
          await store.kv.set(["thread", thread.thread.id], {
            ...threadEntry,
            title: "Renamed mid-flight",
          });
          return { ok: false };
        }
        return await commit();
      };
      return op;
    };
    let followed: { following: boolean; followers: number } | null = null;
    try {
      followed = await store.followThread(peer, thread.thread.id);
    } finally {
      store.kv.atomic = original;
    }
    assertEquals(
      followed?.following,
      true,
      "a rename must not refuse a follow",
    );
    assertEquals(followed?.followers, 2);
    assertEquals(await countKeyPrefix(store.kv, ["thread-follower"]), 2);
  });
});

Deno.test("the catch-up feed lists public messages newest first and never DMs", async () => {
  await withStore(async (store) => {
    const author = session("feed-author");
    const peer = session("feed-peer");
    await store.authenticate(author, "feed_author", password);
    await store.authenticate(peer, "feed_peer", password);
    const category = await store.createCategory(author, "Feed");
    const thread = await store.postThread(
      author,
      category.id,
      "First public message",
    );
    await store.sendDm(author, "feed_peer", "Private note");
    const reply = await store.reply(
      peer,
      thread.thread.id,
      "Second public message",
    );

    const feed = await store.listFeed();
    assertEquals(
      feed.items.map((item) => item.message.text),
      ["Second public message", "First public message"],
    );
    assertEquals(feed.items[1].categoryId, category.id);
    assertEquals(feed.items[1].threadId, thread.thread.id);
    assertEquals(feed.items[1].messageId, thread.message.id);

    const firstPage = await store.listFeed({ limit: 1 });
    assertEquals(firstPage.items.map((item) => item.message.id), [reply.id]);
    assert(firstPage.nextCursor);
    const secondPage = await store.listFeed({
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    assertEquals(
      secondPage.items.map((item) => item.message.id),
      [thread.message.id],
    );

    // A deleted message keeps its position but drops out of the feed.
    await store.kv.set(["message", reply.id], {
      ...reply,
      deletedAt: new Date().toISOString(),
    });
    assertEquals(
      (await store.listFeed()).items.map((item) => item.message.id),
      [thread.message.id],
    );

    // Boards written before the feed existed are restored in place by the backfill.
    for await (const entry of store.kv.list({ prefix: ["feed"] })) {
      await store.kv.delete(entry.key);
    }
    assertEquals((await store.listFeed()).items.length, 0);
    const backfilled = await backfillFeed(store.kv);
    assertEquals(backfilled.indexed, 1);
    assertEquals(
      backfilled.skipped,
      2,
      "the deleted reply and the DM are skipped",
    );
    assertEquals(
      (await store.listFeed()).items.map((item) => item.message.id),
      [thread.message.id],
    );
    const repeated = await backfillFeed(store.kv);
    assertEquals(repeated.indexed, 0);
    assertEquals(repeated.alreadyIndexed, 1);
  });
});
