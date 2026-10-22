import type { Category, SessionIdentity, Thread } from "./types.ts";
import { requireAccount } from "./identity.ts";
import { errorText, recordLog } from "../infra/logs.ts";

/**
 * Upper bound on a thread's follower index. Reply notifications are written in
 * the same atomic commit as the message, so the follower set must stay small
 * enough for one commit; the counter below enforces the bound in every commit
 * that adds a follower.
 */
export const MAX_THREAD_FOLLOWERS = 100;

export interface FollowRecord {
  accountId: string;
  threadId: string;
  createdAt: string;
}

/** Follower total for a thread, plus the counter version that serializes writes. */
export interface FollowerCount {
  /** Inverse-index length at read time, capped by the bounded read window. */
  count: number;
  /** Version of the shared counter slot that add, remove and fan-out guard check. */
  versionstamp: string | null;
}

/** The follower index at one instant, with the version that pins it. */
export interface FollowerSnapshot {
  accountIds: string[];
  versionstamp: string | null;
}

/** The forward and reverse halves of one follow, which must always agree. */
function followKeys(
  accountId: string,
  threadId: string,
): [Deno.KvKey, Deno.KvKey] {
  return [["follow", accountId, threadId], [
    "thread-follower",
    threadId,
    accountId,
  ]];
}

function followerCountKey(threadId: string) {
  return ["thread-follower-count", threadId];
}

/** The thread and category entries a follow commit has to still find. */
export interface ThreadGuards {
  threadEntry: Deno.KvEntryMaybe<Thread>;
  categoryEntry: Deno.KvEntryMaybe<Category>;
}

export class Follows {
  constructor(readonly kv: Deno.Kv) {}

  /**
   * Follows an existing public thread in an active category for this account.
   * An existing follow is unchanged, even at the 100-follower cap. Returns the
   * thread ID, following status, and observed follower count.
   *
   * @throws {Error} If unauthenticated, the thread or category is unavailable,
   * the thread is private, the category is archived, a new follow exceeds the
   * cap, or repeated concurrent changes prevent saving. Storage errors propagate.
   */
  async follow(session: SessionIdentity, threadId: string) {
    const accountId = requireAccount(session);
    // Fail fast with the caller's own error before touching the follower index.
    await this.readFollowableThread(threadId);
    const result = await this.addFollower(threadId, accountId, true);
    if (result.outcome === "full") {
      throw new Error(
        `This thread already has the maximum of ${MAX_THREAD_FOLLOWERS} followers.`,
      );
    }
    if (result.outcome === "conflict") {
      // Re-read before reporting contention: an owner who archived or deleted
      // the thread mid-flight should hear that, not "retry".
      await this.readFollowableThread(threadId);
      throw new Error("The follower list changed repeatedly; retry.");
    }
    return { threadId, following: true, followers: result.count };
  }

  /**
   * Follows a thread on behalf of someone who just posted in it. The caller's
   * message is already committed by then, so this never throws: a fault here is
   * logged, and the worst case is a missing auto-follow, never a reported
   * failure for a write that succeeded. A full follower set or repeated
   * conflicts also leave the thread unfollowed without failing the message.
   */
  async autoFollow(threadId: string, accountId: string) {
    try {
      await this.addFollower(threadId, accountId);
    } catch (error) {
      recordLog("warn", "follows:auto-follow", errorText(error));
    }
  }

  /**
   * Removes this account's follow, including a thread whose category was later
   * archived or deleted. Deleting unknown entries is a no-op, so an unhandled
   * retry is safe. Existing inbox entries remain. Returns the thread ID,
   * following: false, and a follower count; after a fallback removal, a failed
   * count read uses the locally computed count. Authentication and other
   * storage errors propagate.
   */
  async unfollow(session: SessionIdentity, threadId: string) {
    const accountId = requireAccount(session);
    const [forwardKey, reverseKey] = followKeys(accountId, threadId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const counter = await this.followerCount(threadId);
      if (!(await this.kv.get(forwardKey)).value) {
        return { threadId, following: false, followers: counter.count };
      }
      const remaining = Math.max(counter.count - 1, 0);
      const op = this.kv.atomic()
        .check({
          key: followerCountKey(threadId),
          versionstamp: counter.versionstamp,
        })
        .delete(forwardKey)
        .delete(reverseKey);
      if (counter.versionstamp !== null) {
        op.set(followerCountKey(threadId), remaining);
      }
      if ((await op.commit()).ok) {
        return { threadId, following: false, followers: remaining };
      }
      if (attempt === 4) {
        // Removal wins over bookkeeping: an unchecked decrement cannot admit an
        // over-cap follow, because the cap reads the index, and leaving the
        // counter high would only misdescribe a slot nobody consults.
        await this.kv.atomic()
          .delete(forwardKey)
          .delete(reverseKey)
          .set(followerCountKey(threadId), remaining)
          .commit();
        return {
          threadId,
          following: false,
          followers: await this.reportTotal(threadId, remaining),
        };
      }
    }
    throw new Error("The follower list changed repeatedly; retry.");
  }

  /**
   * The follower index and the version that pins it, read counter-first: a
   * follow that lands between the two reads then leaves the version behind the
   * index, so a commit guarded by it fails and retries instead of notifying a
   * stale set. Reading the index first would hide exactly that case.
   */
  async followerSnapshot(threadId: string): Promise<FollowerSnapshot> {
    const counter = await this.kv.get<number>(followerCountKey(threadId));
    return {
      accountIds: await this.followerIds(threadId),
      versionstamp: counter.versionstamp,
    };
  }

  /**
   * Holds a commit to the follower index it was built from, so a notification
   * set is never written against an index that has already moved.
   */
  guardFollowerSnapshot(
    op: Deno.AtomicOperation,
    threadId: string,
    snapshot: FollowerSnapshot,
  ) {
    op.check({
      key: followerCountKey(threadId),
      versionstamp: snapshot.versionstamp,
    });
  }

  /**
   * Follower account IDs for a thread in index order. The shared counter keeps
   * the index at or below the cap, so the extra entry of headroom is only a
   * guard against a counter that a hand-edited database left behind.
   */
  async followerIds(threadId: string) {
    const accountIds: string[] = [];
    for await (
      const entry of this.kv.list({ prefix: ["thread-follower", threadId] }, {
        limit: MAX_THREAD_FOLLOWERS + 1,
      })
    ) {
      accountIds.push(String(entry.key[2]));
    }
    return accountIds;
  }

  /**
   * The follower total and the counter version to check. The total is the index
   * length — the physical truth, bounded by the read window — while the stored
   * counter exists only to give every add and remove a shared version to check,
   * which is what serializes concurrent follows. Deciding on the index rather
   * than the stored number means a counter that ever lagged, from a hand-edited
   * database or a lost decrement, can neither make the cap stricter nor burn a
   * follower slot.
   */
  async followerCount(threadId: string): Promise<FollowerCount> {
    const entry = await this.kv.get<number>(followerCountKey(threadId));
    return {
      count: (await this.followerIds(threadId)).length,
      versionstamp: entry.versionstamp,
    };
  }

  /** Adds a follower pair and bumps the shared counter in the caller's commit. */
  private setFollower(
    op: Deno.AtomicOperation,
    threadId: string,
    accountId: string,
    createdAt: string,
    counter: FollowerCount,
  ) {
    const record: FollowRecord = { accountId, threadId, createdAt };
    const [forwardKey, reverseKey] = followKeys(accountId, threadId);
    op.check({
      key: followerCountKey(threadId),
      versionstamp: counter.versionstamp,
    })
      .set(forwardKey, record)
      .set(reverseKey, true)
      .set(followerCountKey(threadId), counter.count + 1);
  }

  /**
   * Adds a follow under the shared counter's version check, reporting the total
   * it left behind so callers never need a read after their own write. Returns
   * `full` without writing when the thread holds the cap, and `conflict` when
   * the counter moved under every attempt.
   */
  private async addFollower(
    threadId: string,
    accountId: string,
    validateThread = false,
  ): Promise<
    { outcome: "added" | "already" | "full"; count: number } | {
      outcome: "conflict";
    }
  > {
    const [forwardKey] = followKeys(accountId, threadId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const follower = await this.kv.get(forwardKey);
      const counter = await this.followerCount(threadId);
      if (follower.value) return { outcome: "already", count: counter.count };
      // Refreshed every attempt: a benign rename or a reopened category between
      // attempts would otherwise pin a versionstamp that can never match again,
      // refusing a follow that the thread still allows. Refreshing before the
      // cap check also means an unavailable thread reports that, not the cap.
      const guards = validateThread
        ? await this.readFollowableThread(threadId)
        : null;
      if (counter.count >= MAX_THREAD_FOLLOWERS) {
        return { outcome: "full", count: counter.count };
      }
      const op = this.kv.atomic().check({
        key: forwardKey,
        versionstamp: null,
      });
      // The guard makes an archive or deletion mid-flight fail this commit
      // rather than leave a follow nothing can use.
      if (guards) op.check(guards.threadEntry, guards.categoryEntry);
      this.setFollower(
        op,
        threadId,
        accountId,
        new Date().toISOString(),
        counter,
      );
      if ((await op.commit()).ok) {
        return { outcome: "added", count: counter.count + 1 };
      }
    }
    return { outcome: "conflict" };
  }

  /**
   * The total to report after a fallback write, where the value written cannot
   * vouch for itself because concurrent adds may have landed. The index is
   * authoritative, so it is read back when that is possible; reading a number
   * must never turn a completed write into a failure, so a failed read reports
   * the value computed on the spot instead.
   */
  private async reportTotal(threadId: string, computed: number) {
    try {
      return (await this.followerCount(threadId)).count;
    } catch {
      return computed;
    }
  }

  /**
   * Returns a public thread whose category exists and is writable.
   * Throws for missing or deleted threads or categories, private threads, and
   * archived categories; storage errors propagate.
   */
  private async readFollowableThread(threadId: string): Promise<ThreadGuards> {
    const threadEntry = await this.kv.get<Thread>(["thread", threadId]);
    if (
      !threadEntry.value || threadEntry.value.deletedAt ||
      threadEntry.value.archivedAt || threadEntry.value.purgingAt
    ) {
      throw new Error("Thread not found.");
    }
    if (threadEntry.value.kind !== "public") {
      throw new Error("Use dm_send for private conversations.");
    }
    const categoryEntry = await this.kv.get<Category>([
      "category",
      threadEntry.value.categoryId!,
    ]);
    if (
      !categoryEntry.value || categoryEntry.value.deletedAt ||
      categoryEntry.value.purgingAt
    ) {
      throw new Error("Category not found.");
    }
    if (categoryEntry.value.archivedAt) {
      throw new Error("This category is archived and read-only.");
    }
    return { threadEntry, categoryEntry };
  }
}
