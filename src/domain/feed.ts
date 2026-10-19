import type { Message, Thread } from "./types.ts";

/**
 * Board-order position of one public message. The key is the versionstamp of
 * the commit that wrote the message, so listing the feed newest-first is a
 * reverse KV prefix listing and needs no extra ordering field.
 */
export const FEED_PREFIX: Deno.KvKey = ["feed"];

export interface FeedEntry {
  messageId: string;
  threadId: string;
  categoryId: string;
}

export function feedKey(stamp: Deno.KvKeyPart): Deno.KvKey {
  return [...FEED_PREFIX, stamp];
}

export interface FeedBackfill {
  indexed: number;
  alreadyIndexed: number;
  skipped: number;
}

/**
 * Indexes public messages from before the feed existed. Each message's
 * `thread-message` index entry already carries its commit versionstamp, so
 * backfilled entries keep their original board position. Existing entries are
 * never rewritten, which makes an interrupted run resumable.
 */
export async function backfillFeed(kv: Deno.Kv): Promise<FeedBackfill> {
  const summary: FeedBackfill = { indexed: 0, alreadyIndexed: 0, skipped: 0 };
  for await (const entry of kv.list({ prefix: ["thread-message"] })) {
    const threadId = String(entry.key[1]);
    const stamp = String(entry.key[2]);
    const thread = (await kv.get<Thread>(["thread", threadId])).value;
    if (
      !thread || thread.deletedAt || thread.kind !== "public" ||
      !thread.categoryId
    ) {
      summary.skipped++;
      continue;
    }
    if ((await kv.get(feedKey(stamp))).value) {
      summary.alreadyIndexed++;
      continue;
    }
    const message = (await kv.get<Message>(["message", String(entry.value)]))
      .value;
    if (!message || message.deletedAt) {
      summary.skipped++;
      continue;
    }
    await kv.set(
      feedKey(stamp),
      {
        messageId: message.id,
        threadId,
        categoryId: thread.categoryId,
      } satisfies FeedEntry,
    );
    summary.indexed++;
  }
  return summary;
}
