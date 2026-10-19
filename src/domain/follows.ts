import type { Category, SessionIdentity, Thread } from "./types.ts";
import { requireAccount } from "./identity.ts";

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

/** Shared follower total for a thread, and the version it was read at. */
export interface FollowerCount {
  count: number;
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
    const outcome = await this.addFollower(threadId, accountId);
    if (outcome === "full") {
      throw new Error(
        `This thread already has the maximum of ${MAX_THREAD_FOLLOWERS} followers.`,
      );
    }
    if (outcome === "conflict") {
      throw new Error("The follower list changed repeatedly; retry.");
    }
    return await this.followState(threadId, true);
  }

  /**
   * Follows a thread on behalf of someone who just posted in it. Never throws
   * for a full or contended thread: the caller's write has already committed,
   * so bookkeeping must not turn into a failure it would have to report.
   */
  async autoFollow(threadId: string, accountId: string) {
    await this.addFollower(threadId, accountId);
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
      if (!(await this.kv.get(forwardKey)).value) break;
      const counter = await this.followerCount(threadId);
      const op = this.kv.atomic()
        .check({
          key: followerCountKey(threadId),
          versionstamp: counter.versionstamp,
        })
        .delete(forwardKey)
        .delete(reverseKey);
      if (counter.versionstamp !== null) {
        op.set(followerCountKey(threadId), Math.max(counter.count - 1, 0));
      }
      if ((await op.commit()).ok) break;
      if (attempt === 4) {
        // A counter left too high only makes the cap stricter, so removal wins.
        await this.kv.atomic().delete(forwardKey).delete(reverseKey).commit();
      }
    }
    return await this.followState(threadId, false);
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
   * The shared follower total and the version the counter was read at. The
   * stored counter is the slot every commit that adds or removes a follower
   * version-checks, which is what serializes concurrent follows; the reported
   * total is the larger of it and the index length, so a counter that lagged
   * behind the index — a hand-edited database — can only make the cap stricter,
   * never looser.
   */
  async followerCount(threadId: string): Promise<FollowerCount> {
    const entry = await this.kv.get<number>(followerCountKey(threadId));
    const indexed = (await this.followerIds(threadId)).length;
    const stored = typeof entry.value === "number" ? entry.value : 0;
    return {
      count: Math.max(stored, indexed),
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

  private async followState(threadId: string, following: boolean) {
    return {
      threadId,
      following,
      followers: (await this.followerCount(threadId)).count,
    };
  }

  private async addFollower(
    threadId: string,
    accountId: string,
  ): Promise<"added" | "already" | "full" | "conflict"> {
    const [forwardKey] = followKeys(accountId, threadId);
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await this.kv.get(forwardKey)).value) return "already";
      const counter = await this.followerCount(threadId);
      if (counter.count >= MAX_THREAD_FOLLOWERS) return "full";
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
      if ((await op.commit()).ok) return "added";
    }
    return "conflict";
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
