import type { Category, SessionIdentity, Thread } from "./types.ts";
import { requireAccount } from "./identity.ts";

/**
 * Upper bound on a thread's follower index. Reply notifications are written in
 * the same atomic commit as the message, so the follower set must stay small
 * enough for one commit; exceeding this bound rejects new explicit follows and
 * silently skips auto-follow.
 */
export const MAX_THREAD_FOLLOWERS = 100;

export interface FollowRecord {
  accountId: string;
  threadId: string;
  createdAt: string;
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

export class Follows {
  constructor(readonly kv: Deno.Kv) {}

  async follow(session: SessionIdentity, threadId: string) {
    const accountId = requireAccount(session);
    await this.readFollowableThread(threadId);
    const [forwardKey] = followKeys(accountId, threadId);
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await this.kv.get(forwardKey)).value) break;
      const followers = await this.followerIds(threadId);
      if (followers.length >= MAX_THREAD_FOLLOWERS) {
        throw new Error(
          `This thread already has the maximum of ${MAX_THREAD_FOLLOWERS} followers.`,
        );
      }
      const op = this.kv.atomic().check({
        key: forwardKey,
        versionstamp: null,
      });
      this.setFollower(op, threadId, accountId, new Date().toISOString());
      if ((await op.commit()).ok) break;
    }
    return {
      threadId,
      following: true,
      followers: (await this.followerIds(threadId)).length,
    };
  }

  /**
   * Removes this account's follow, including a thread whose category was later
   * archived or deleted. Deleting unknown entries is a no-op, so an unhandled
   * retry is safe.
   */
  async unfollow(session: SessionIdentity, threadId: string) {
    const accountId = requireAccount(session);
    const [forwardKey, reverseKey] = followKeys(accountId, threadId);
    await this.kv.atomic()
      .delete(forwardKey)
      .delete(reverseKey)
      .commit();
    return {
      threadId,
      following: false,
      followers: (await this.followerIds(threadId)).length,
    };
  }

  /**
   * Follower account IDs for a thread in index order, read with one entry of
   * headroom so callers can detect a full index without a second read.
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

  /** Adds a follower pair to the caller's open atomic commit. */
  setFollower(
    op: Deno.AtomicOperation,
    threadId: string,
    accountId: string,
    createdAt: string,
  ) {
    const record: FollowRecord = { accountId, threadId, createdAt };
    const [forwardKey, reverseKey] = followKeys(accountId, threadId);
    op.set(forwardKey, record).set(reverseKey, true);
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
