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
  /** Version of the shared counter slot every add and remove checks. */
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

export class Follows {
  constructor(readonly kv: Deno.Kv) {}

  async follow(session: SessionIdentity, threadId: string) {
    const accountId = requireAccount(session);
    await this.readFollowableThread(threadId);
    const result = await this.addFollower(threadId, accountId);
    if (result.outcome === "full") {
      throw new Error(
        `This thread already has the maximum of ${MAX_THREAD_FOLLOWERS} followers.`,
      );
    }
    if (result.outcome === "conflict") {
      throw new Error("The follower list changed repeatedly; retry.");
    }
    return { threadId, following: true, followers: result.count };
  }

  /**
   * Follows a thread on behalf of someone who just posted in it. The caller's
   * message is already committed by then, so this never throws: a fault here is
   * logged, and the worst case is a missing auto-follow, never a reported
   * failure for a write that succeeded.
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
   * retry is safe.
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
        // over-cap follow, because the reported total never drops below the
        // index length, and leaving the counter high would burn a follow slot
        // on this thread for good.
        await this.kv.atomic()
          .delete(forwardKey)
          .delete(reverseKey)
          .set(followerCountKey(threadId), remaining)
          .commit();
        return { threadId, following: false, followers: remaining };
      }
    }
    throw new Error("The follower list changed repeatedly; retry.");
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
      if (counter.count >= MAX_THREAD_FOLLOWERS) {
        return { outcome: "full", count: counter.count };
      }
      const op = this.kv.atomic().check({
        key: forwardKey,
        versionstamp: null,
      });
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

  private async readFollowableThread(threadId: string) {
    const entry = await this.kv.get<Thread>(["thread", threadId]);
    if (!entry.value || entry.value.deletedAt) {
      throw new Error("Thread not found.");
    }
    if (entry.value.kind !== "public") {
      throw new Error("Use dm_send for private conversations.");
    }
    const category = await this.kv.get<Category>([
      "category",
      entry.value.categoryId!,
    ]);
    if (!category.value || category.value.deletedAt) {
      throw new Error("Category not found.");
    }
    if (category.value.archivedAt) {
      throw new Error("This category is archived and read-only.");
    }
    return entry.value;
  }
}
