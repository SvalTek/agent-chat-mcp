import type {
  Category,
  Message,
  PublicAccount,
  SessionIdentity,
  Thread,
} from "./types.ts";
import { EventHub } from "./events.ts";
import { requireAccount } from "./identity.ts";
import { decodeCursor, listPage, pageLimit } from "../storage/pagination.ts";
import { Accounts } from "./accounts.ts";
import { readSettings } from "./settings.ts";
import { Follows } from "./follows.ts";
import { FEED_PREFIX, type FeedEntry, feedKey } from "./feed.ts";
import { hex } from "../auth/passwords.ts";
const MENTION_RE = /(?<![\w@])@([A-Za-z][A-Za-z0-9_-]{2,31})(?![A-Za-z0-9_-])/g;
const MAX_MENTIONS = 20;
const MAX_TEXT_LENGTH = 20000;

/** Candidate messages one search examines before it stops. */
const SEARCH_SCAN_LIMIT = 1000;

/** A search hit: the indexed position plus the current message. */
export interface SearchItem {
  messageId: string;
  threadId: string;
  categoryId: string | null;
  message: Message;
}

/** Retry controls shared by the write tools that machine clients may repeat. */
export interface WriteOptions {
  /**
   * Client-generated key identifying one logical write. Repeating a write with
   * the same key returns the original result instead of writing again.
   */
  idempotencyKey?: string;
}

interface IdempotencyRecord {
  digest: string;
  messageId: string;
  threadId: string;
  created?: boolean;
}

interface IdempotencyClaim {
  key: Deno.KvKey;
  digest: string;
  existing: IdempotencyRecord | null;
}

async function digestPayload(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function validateText(value: string) {
  const text = value.trim();
  if (!text) throw new Error("Message text cannot be empty.");
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(
      `Message text is limited to ${MAX_TEXT_LENGTH} characters.`,
    );
  }
  if (new TextEncoder().encode(text).length > 48000) {
    throw new Error("Message text must fit within 48000 UTF-8 bytes.");
  }
  return text;
}

export class Messages {
  constructor(
    readonly kv: Deno.Kv,
    readonly events: EventHub,
    readonly accounts: Accounts,
    readonly follows: Follows,
  ) {}
  /**
   * Creates a public thread and its first message, returning both records.
   * Trims text, adds the message to the feed, notifies resolved mentions, and
   * updates the session's latest message. Account authors are auto-followed on
   * a best-effort basis; follower failures do not fail a committed post.
   *
   * A nonempty idempotency key is scoped to the account (or anonymous session)
   * and this operation. Matching retries return the stored records, including
   * later edits, without repeating side effects. The category ID and untrimmed
   * text must match the original inputs exactly.
   *
   * @throws {Error} For disabled anonymous posting, a missing/deleted or archived
   * category, empty text, text over 20,000 UTF-16 code units or 48,000 UTF-8 bytes,
   * over 20 distinct mention names, or a concurrent category change. Key reuse
   * with different inputs or an unavailable replay record also throws. Storage,
   * mention lookup, and digest errors propagate.
   */
  async postThread(
    session: SessionIdentity,
    categoryId: string,
    textInput: string,
    options: WriteOptions = {},
  ) {
    const idempotency = options.idempotencyKey
      ? await this.claimIdempotency(
        session,
        "message_post",
        options.idempotencyKey,
        [categoryId, textInput],
      )
      : null;
    if (idempotency && idempotency.existing) {
      const replay = await this.completedIdempotentWrite(
        idempotency.existing,
        idempotency.digest,
      );
      return { thread: replay.thread, message: replay.message };
    }
    if (
      !session.accountId &&
      !(await readSettings(this.kv)).anonymousPostingEnabled
    ) throw new Error("Anonymous posting is disabled by the owner.");
    const categoryEntry = await this.kv.get<Category>(["category", categoryId]);
    if (!categoryEntry.value || categoryEntry.value.deletedAt) {
      throw new Error("Category not found.");
    }
    if (categoryEntry.value.archivedAt) {
      throw new Error("This category is archived and read-only.");
    }
    const text = validateText(textInput);
    const mentions = await this.resolveMentions(text, session.accountId);
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const thread: Thread = {
      id: threadId,
      kind: "public",
      categoryId,
      participants: [],
      createdByAccountId: session.accountId,
      createdAt: now,
      title: text.slice(0, 120),
    };
    const message: Message = {
      id: messageId,
      threadId,
      senderAccountId: session.accountId,
      senderUsername: await this.accounts.sessionUsername(session),
      senderSessionId: session.id,
      text,
      mentions,
      createdAt: now,
      editedAt: null,
    };
    const op = this.kv.atomic()
      .check(categoryEntry)
      .set(["thread", threadId], thread)
      .set(
        ["category-thread", categoryId, this.kv.commitVersionstamp()],
        threadId,
      )
      .set(["message", messageId], message)
      .set(
        ["thread-message", threadId, this.kv.commitVersionstamp()],
        messageId,
      );
    for (const account of mentions) {
      op.set(["inbox", account.id, this.kv.commitVersionstamp()], {
        messageId,
        threadId,
        kind: "mention",
      });
    }
    if (session.accountId === null) {
      op.set(["session-last-message", session.id], messageId);
    }
    // Public messages enter the catch-up feed at their commit position.
    op.set(
      feedKey(this.kv.commitVersionstamp()),
      {
        messageId,
        threadId,
        categoryId,
      } satisfies FeedEntry,
    );
    if (idempotency) {
      this.recordIdempotentWrite(op, idempotency, { messageId, threadId });
    }
    const result = await op.commit();
    if (!result.ok) {
      if (idempotency) {
        const replay = await this.replayIdempotent(idempotency);
        if (replay) return { thread: replay.thread, message: replay.message };
      }
      throw new Error("Category changed while posting; reload and retry.");
    }
    session.lastMessageId = messageId;
    const recipientIds = mentions.map((account) => account.id);
    // The author follows the thread they started, so later replies reach them.
    // Installed before the change is announced: a peer reacting to the event
    // must not be able to reply into a thread its author does not follow yet.
    if (session.accountId) {
      await this.follows.autoFollow(threadId, session.accountId);
    }
    this.events.publish({
      publicUris: [
        "agent-chat://categories",
        "agent-chat://feed",
        `agent-chat://categories/${categoryId}/threads`,
        `agent-chat://threads/${threadId}`,
      ],
      accountUris: Object.fromEntries(
        recipientIds.map((id) => [id, ["agent-chat://inbox/me"]]),
      ),
    });
    return { thread, message };
  }

  /**
   * Appends and returns a public reply, indexing it in the feed and updating
   * the session's latest message. Mentions and followers other than the sender
   * receive inbox entries; a mentioned follower receives only a mention entry.
   * Account senders are auto-followed on a best-effort basis after the commit.
   *
   * A nonempty idempotency key is scoped to this operation and the account or
   * anonymous session. Matching retries return the stored message, including
   * later edits, without repeating notifications or auto-following. The thread
   * ID and untrimmed text must match the original inputs exactly.
   *
   * @throws {Error} For disabled anonymous posting, missing/deleted threads or
   * categories, private threads, archived categories, empty text, text over
   * 20,000 UTF-16 code units or 48,000 UTF-8 bytes, over 20 distinct mention names,
   * or concurrent thread/category changes. Conflicting key reuse or unavailable
   * replay records throw. Storage, mention lookup, and digest errors propagate;
   * auto-follow errors are caught.
   */
  async reply(
    session: SessionIdentity,
    threadId: string,
    textInput: string,
    options: WriteOptions = {},
  ) {
    const idempotency = options.idempotencyKey
      ? await this.claimIdempotency(
        session,
        "message_reply",
        options.idempotencyKey,
        [threadId, textInput],
      )
      : null;
    if (idempotency && idempotency.existing) {
      const replay = await this.completedIdempotentWrite(
        idempotency.existing,
        idempotency.digest,
      );
      return replay.message;
    }
    if (
      !session.accountId &&
      !(await readSettings(this.kv)).anonymousPostingEnabled
    ) throw new Error("Anonymous posting is disabled by the owner.");
    const threadEntry = await this.kv.get<Thread>(["thread", threadId]);
    if (!threadEntry.value || threadEntry.value.deletedAt) {
      throw new Error("Thread not found.");
    }
    if (threadEntry.value.kind !== "public") {
      throw new Error("Use dm_send for private conversations.");
    }
    const categoryEntry = await this.kv.get<Category>([
      "category",
      threadEntry.value.categoryId!,
    ]);
    if (!categoryEntry.value || categoryEntry.value.deletedAt) {
      throw new Error("Category not found.");
    }
    if (categoryEntry.value.archivedAt) {
      throw new Error("This category is archived and read-only.");
    }
    const text = validateText(textInput);
    const mentions = await this.resolveMentions(text, session.accountId);
    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const message: Message = {
      id: messageId,
      threadId,
      senderAccountId: session.accountId,
      senderUsername: await this.accounts.sessionUsername(session),
      senderSessionId: session.id,
      text,
      mentions,
      createdAt: now,
      editedAt: null,
    };
    // The notification set is only correct for the follower index this commit
    // observed, so the same commit verifies that index has not moved; a lost
    // race rebuilds the page from a fresh snapshot rather than dropping a
    // notification or sending one to an account that has just unfollowed.
    const commitReply = async () => {
      const snapshot = await this.follows.followerSnapshot(threadId);
      const op = this.kv.atomic()
        .check(threadEntry, categoryEntry)
        .set(["message", messageId], message)
        .set(
          ["thread-message", threadId, this.kv.commitVersionstamp()],
          messageId,
        );
      if (session.accountId === null) {
        op.set(["session-last-message", session.id], messageId);
      }
      const recipients = new Set(mentions.map((account) => account.id));
      for (const account of mentions) {
        op.set(["inbox", account.id, this.kv.commitVersionstamp()], {
          messageId,
          threadId,
          kind: "mention",
        });
      }
      // A mentioned follower is notified once, as a mention, not again as a reply.
      for (const accountId of snapshot.accountIds) {
        if (accountId === session.accountId || recipients.has(accountId)) {
          continue;
        }
        op.set(["inbox", accountId, this.kv.commitVersionstamp()], {
          messageId,
          threadId,
          kind: "reply",
        });
        recipients.add(accountId);
      }
      // Public messages enter the catch-up feed at their commit position.
      op.set(
        feedKey(this.kv.commitVersionstamp()),
        {
          messageId,
          threadId,
          categoryId: threadEntry.value.categoryId!,
        } satisfies FeedEntry,
      );
      if (idempotency) {
        this.recordIdempotentWrite(op, idempotency, { messageId, threadId });
      }
      const guarded = snapshot.accountIds.length > 0;
      if (guarded) {
        this.follows.guardFollowerSnapshot(op, threadId, snapshot);
      }
      return { result: await op.commit(), recipients, guarded };
    };
    let attempt = await commitReply();
    // Only a commit that checked the follower index has a reason to retry; any
    // other conflict would fail again on the same thread and category entries.
    if (!attempt.result.ok && attempt.guarded) {
      attempt = await commitReply();
    }
    const { result } = attempt;
    if (!result.ok) {
      if (idempotency) {
        const replay = await this.replayIdempotent(idempotency);
        if (replay) return replay.message;
      }
      throw new Error(
        "Thread or category changed while replying; reload and retry.",
      );
    }
    session.lastMessageId = messageId;
    const recipientIds = [...attempt.recipients];
    // Replying follows the thread before the change is announced, so a peer
    // reacting to the event cannot reply into a thread the replier does not
    // follow yet.
    if (session.accountId) {
      await this.follows.autoFollow(threadId, session.accountId);
    }
    this.events.publish({
      publicUris: [
        "agent-chat://feed",
        `agent-chat://threads/${threadId}`,
        `agent-chat://categories/${threadEntry.value.categoryId}/threads`,
      ],
      accountUris: Object.fromEntries(
        recipientIds.map((id) => [id, ["agent-chat://inbox/me"]]),
      ),
    });
    return message;
  }

  /**
   * Sends a private message to a registered username in the account pair's
   * shared thread. Returns its threadId, message, and whether this write created
   * the thread. Notifies the recipient and updates the session's latest message;
   * DMs do not enter the public feed or resolve mentions.
   *
   * A nonempty idempotency key is scoped to the sender account and this operation.
   * An exact retry of the recipient name and untrimmed text returns the stored
   * message (including later edits) and original created flag without sending again.
   *
   * @throws {Error} If unauthenticated, the recipient is unknown or is the sender,
   * trimmed text is empty or exceeds 20,000 UTF-16 code units or 48,000 UTF-8 bytes,
   * or opening/committing the conversation fails. Conflicting key reuse and
   * unavailable replay records throw. Storage, lookup, and digest errors propagate.
   */
  async sendDm(
    session: SessionIdentity,
    recipientName: string,
    textInput: string,
    options: WriteOptions = {},
  ) {
    const senderId = requireAccount(session);
    const idempotency = options.idempotencyKey
      ? await this.claimIdempotency(
        session,
        "dm_send",
        options.idempotencyKey,
        [recipientName, textInput],
      )
      : null;
    if (idempotency && idempotency.existing) {
      const replay = await this.completedIdempotentWrite(
        idempotency.existing,
        idempotency.digest,
      );
      return {
        threadId: replay.thread.id,
        message: replay.message,
        created: replay.created,
      };
    }
    const recipient = await this.accounts.resolveUsername(recipientName);
    if (!recipient) throw new Error("Recipient must be a registered username.");
    if (recipient.id === senderId) {
      throw new Error("You cannot start a direct message with yourself.");
    }
    const text = validateText(textInput);
    const [low, high] = [senderId, recipient.id].sort();
    const pairKey = ["dm-pair", low, high] as const;
    let threadId = (await this.kv.get<string>(pairKey)).value;
    let created = false;
    if (!threadId) {
      const now = new Date().toISOString();
      const newId = crypto.randomUUID();
      const thread: Thread = {
        id: newId,
        kind: "dm",
        categoryId: null,
        participants: [low, high],
        createdByAccountId: senderId,
        createdAt: now,
        title: `Direct message: ${recipient.username}`,
      };
      const message = await this.makeMessage(session, newId, text, []);
      const op = this.kv.atomic()
        .check({ key: pairKey, versionstamp: null })
        .set(pairKey, newId)
        .set(["thread", newId], thread)
        .set(["message", message.id], message)
        .set(
          ["thread-message", newId, this.kv.commitVersionstamp()],
          message.id,
        )
        .set(["inbox", recipient.id, this.kv.commitVersionstamp()], {
          messageId: message.id,
          threadId: newId,
          kind: "dm",
        });
      if (idempotency) {
        this.recordIdempotentWrite(op, idempotency, {
          messageId: message.id,
          threadId: newId,
          created: true,
        });
      }
      const result = await op.commit();
      if (result.ok) {
        threadId = newId;
        created = true;
        session.lastMessageId = message.id;
        this.events.publish({
          publicUris: [],
          accountUris: {
            [senderId]: [`agent-chat://dms/${newId}`],
            [recipient.id]: [
              `agent-chat://dms/${newId}`,
              "agent-chat://inbox/me",
            ],
          },
        });
        return { threadId, message, created };
      }
      if (idempotency) {
        const replay = await this.replayIdempotent(idempotency);
        if (replay) {
          return {
            threadId: replay.thread.id,
            message: replay.message,
            created: replay.created,
          };
        }
      }
      threadId = (await this.kv.get<string>(pairKey)).value;
    }
    if (!threadId) {
      throw new Error("Could not open the direct-message thread; retry.");
    }
    const message = await this.makeMessage(session, threadId, text, []);
    const op = this.kv.atomic()
      .set(["message", message.id], message)
      .set(
        ["thread-message", threadId, this.kv.commitVersionstamp()],
        message.id,
      )
      .set(["inbox", recipient.id, this.kv.commitVersionstamp()], {
        messageId: message.id,
        threadId,
        kind: "dm",
      });
    if (idempotency) {
      this.recordIdempotentWrite(op, idempotency, {
        messageId: message.id,
        threadId,
        created: false,
      });
    }
    const result = await op.commit();
    if (!result.ok) {
      if (idempotency) {
        const replay = await this.replayIdempotent(idempotency);
        if (replay) {
          return {
            threadId: replay.thread.id,
            message: replay.message,
            created: replay.created,
          };
        }
      }
      throw new Error("Could not commit the direct message; retry.");
    }
    session.lastMessageId = message.id;
    this.events.publish({
      publicUris: [],
      accountUris: {
        [senderId]: [`agent-chat://dms/${threadId}`],
        [recipient.id]: [
          `agent-chat://dms/${threadId}`,
          "agent-chat://inbox/me",
        ],
      },
    });
    return { threadId, message, created };
  }

  /**
   * Replaces and returns an owned message's trimmed text and edited timestamp.
   * Anonymous sessions may edit only their latest stored message. Public edits
   * recompute mentions and notify newly mentioned accounts; DM mentions stay
   * unchanged. Publishes affected thread, inbox, and public feed updates.
   *
   * @throws {Error} For missing/deleted messages, ownership violations, archived
   * categories, empty text, text over 20,000 UTF-16 code units or 48,000 UTF-8 bytes,
   * over 20 distinct public mention names, or a concurrent change. Storage and
   * mention lookup errors propagate, including reads after the edit commits.
   */
  async editMessage(
    session: SessionIdentity,
    messageId: string,
    textInput: string,
  ) {
    const entry = await this.kv.get<Message>(["message", messageId]);
    if (!entry.value || entry.value.deletedAt) {
      throw new Error("Message not found.");
    }
    const latestEntry = await this.kv.get<string>([
      "session-last-message",
      session.id,
    ]);
    const latestAnonymousMessage = latestEntry.value;
    const owner = session.accountId !== null &&
      entry.value.senderAccountId === session.accountId;
    const anonymousLatest = session.accountId === null &&
      latestAnonymousMessage === messageId &&
      entry.value.senderSessionId === session.id;
    if (!owner && !anonymousLatest) {
      throw new Error(
        "You may edit only your own message; anonymous sessions may correct only their latest message.",
      );
    }
    const threadEntry = await this.kv.get<Thread>([
      "thread",
      entry.value.threadId,
    ]);
    const categoryEntry = threadEntry.value?.categoryId
      ? await this.kv.get<Category>(["category", threadEntry.value.categoryId])
      : null;
    if (categoryEntry?.value?.archivedAt) {
      throw new Error("This category is archived and read-only.");
    }
    const text = validateText(textInput);
    const mentions = threadEntry.value?.kind === "public"
      ? await this.resolveMentions(text, session.accountId)
      : entry.value.mentions;
    const updated = {
      ...entry.value,
      text,
      mentions,
      editedAt: new Date().toISOString(),
    };
    const op = this.kv.atomic().check(entry, threadEntry).set(
      entry.key,
      updated,
    );
    if (categoryEntry) op.check(categoryEntry);
    if (session.accountId === null) op.check(latestEntry);
    const oldMentions = new Set(
      entry.value.mentions.map((account) => account.id),
    );
    for (const account of mentions) {
      if (!oldMentions.has(account.id)) {
        op.set(["inbox", account.id, this.kv.commitVersionstamp()], {
          messageId,
          threadId: updated.threadId,
          kind: "mention",
        });
      }
    }
    const result = await op.commit();
    if (!result.ok) {
      throw new Error("Message changed concurrently; reload and retry.");
    }
    const thread =
      (await this.kv.get<Thread>(["thread", updated.threadId])).value;
    const uris = [`agent-chat://threads/${updated.threadId}`];
    if (thread?.kind === "dm") {
      uris.push(`agent-chat://dms/${updated.threadId}`);
    } else if (thread) {
      // The feed resolves message text live, so an edit changes its contents.
      uris.push("agent-chat://feed");
    }
    const recipientIds = updated.mentions.map((account) => account.id);
    this.events.publish({
      publicUris: thread?.kind === "dm" ? [] : uris,
      accountUris: Object.fromEntries(
        [...(thread?.participants ?? []), ...recipientIds].map((
          id,
        ) => [id, [
          ...(thread?.kind === "dm" ? uris : []),
          "agent-chat://inbox/me",
        ]]),
      ),
    });
    return updated;
  }

  async getThread(threadId: string) {
    const thread = (await this.kv.get<Thread>(["thread", threadId])).value;
    if (!thread || thread.deletedAt) return null;
    if (
      thread.categoryId &&
      (await this.kv.get<Category>(["category", thread.categoryId])).value
        ?.deletedAt
    ) return null;
    return thread;
  }

  async getMessage(messageId: string) {
    const message = (await this.kv.get<Message>(["message", messageId])).value;
    return message && !message.deletedAt &&
        await this.getThread(message.threadId)
      ? message
      : null;
  }

  async listThreads(
    categoryId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const scope = `category-threads:${categoryId}`;
    const cursor = decodeCursor<string>(options.cursor, scope);
    return await listPage<Thread>(
      this.kv,
      ["category-thread", categoryId],
      scope,
      cursor,
      pageLimit(options.limit),
      async (entry) => {
        return await this.getThread(String(entry.value));
      },
    );
  }

  async listMessages(
    session: SessionIdentity,
    threadId: string,
    options: { cursor?: string; limit?: number; dm?: boolean } = {},
  ) {
    const thread = await this.getThread(threadId);
    if (!thread) throw new Error("Thread not found.");
    if (
      thread.kind === "dm" &&
      (!session.accountId || !thread.participants.includes(session.accountId))
    ) {
      throw new Error(
        "This private conversation is not available to this session.",
      );
    }
    const scope = `thread-messages:${threadId}`;
    const cursor = decodeCursor<string>(options.cursor, scope);
    return await listPage<Message>(
      this.kv,
      ["thread-message", threadId],
      scope,
      cursor,
      pageLimit(options.limit),
      async (entry) => {
        return await this.getMessage(String(entry.value));
      },
    );
  }

  /**
   * Public messages in board order, newest first, resolved against their
   * current text. Deleted messages drop out. Private messages are never
   * indexed, so opening a DM thread is what recovers missed DMs. The limit
   * defaults to 30 and is floored and clamped to 1–100. Continue with nextCursor
   * until null, even after an empty page; reads are bounded and not snapshots.
   * Invalid or differently scoped cursors and storage errors propagate.
   */
  async listFeed(options: { cursor?: string; limit?: number } = {}) {
    const scope = "feed";
    const cursor = decodeCursor<string>(options.cursor, scope);
    return await listPage<FeedEntry & { message: Message }>(
      this.kv,
      FEED_PREFIX,
      scope,
      cursor,
      pageLimit(options.limit),
      async (entry) => {
        const item = entry.value as FeedEntry;
        const message = await this.getMessage(item.messageId);
        return message ? { ...item, message } : null;
      },
      true,
    );
  }

  /**
   * Searches current text for a trimmed, case-insensitive substring. Board
   * scope uses the feed newest first; thread scope uses newest messages first.
   * Category scope visits newest-created threads first, then each thread's
   * messages newest first, so it does not give global message-recency order.
   * DMs are searchable only by participants within their own thread.
   *
   * Stops after 1000 candidate positions or the match limit (default 30,
   * floored and clamped to 1–100). Returns the trimmed query, hits, scanned
   * count (including missing/deleted messages), scanLimit, and truncated.
   * truncated is true only when another candidate exceeds the scan budget;
   * false does not imply exhaustion when the match limit stopped the scan.
   *
   * @throws {Error} For an empty query, simultaneous category and thread
   * filters, unavailable scopes, or denied DM access. Storage errors propagate.
   */
  async search(
    session: SessionIdentity,
    options: {
      query: string;
      categoryId?: string;
      threadId?: string;
      limit?: number;
    },
  ) {
    const query = options.query.trim();
    if (!query) throw new Error("Enter a search query.");
    if (options.categoryId && options.threadId) {
      throw new Error("Search one thread or one category, not both.");
    }
    const limit = pageLimit(options.limit);
    let thread: Thread | null = null;
    if (options.threadId) {
      thread = await this.getThread(options.threadId);
      if (!thread) throw new Error("Thread not found.");
      if (
        thread.kind !== "public" && !await this.canReadDm(session, thread.id)
      ) throw new Error("Private conversation unavailable.");
    } else if (options.categoryId) {
      const category = await this.kv.get<Category>([
        "category",
        options.categoryId,
      ]);
      if (!category.value || category.value.deletedAt) {
        throw new Error("Category not found.");
      }
    }

    const needle = query.toLowerCase();
    const items: SearchItem[] = [];
    let scanned = 0;
    let truncated = false;
    // Walks one candidate, and reports whether the caller should keep going.
    // The window counts candidates that are in scope, so a category search is
    // not crowded out by newer messages in other categories.
    const examine = async (messageId: string, categoryId: string | null) => {
      if (scanned >= SEARCH_SCAN_LIMIT) {
        truncated = true;
        return false;
      }
      scanned++;
      const message = await this.getMessage(messageId);
      if (!message || !message.text.toLowerCase().includes(needle)) return true;
      items.push({
        messageId: message.id,
        threadId: message.threadId,
        categoryId,
        message,
      });
      return items.length < limit;
    };

    if (thread) {
      for await (
        const entry of this.kv.list(
          { prefix: ["thread-message", thread.id] },
          { reverse: true },
        )
      ) {
        if (!(await examine(String(entry.value), thread.categoryId))) break;
      }
    } else if (options.categoryId) {
      let stop = false;
      for await (
        const entry of this.kv.list(
          { prefix: ["category-thread", options.categoryId] },
          { reverse: true },
        )
      ) {
        if (stop) break;
        const threadId = String(entry.value);
        for await (
          const message of this.kv.list(
            { prefix: ["thread-message", threadId] },
            { reverse: true },
          )
        ) {
          if (!(await examine(String(message.value), options.categoryId))) {
            stop = true;
            break;
          }
        }
      }
    } else {
      for await (
        const entry of this.kv.list({ prefix: FEED_PREFIX }, { reverse: true })
      ) {
        const indexed = entry.value as FeedEntry;
        if (!(await examine(indexed.messageId, indexed.categoryId))) break;
      }
    }
    return { query, scanned, scanLimit: SEARCH_SCAN_LIMIT, truncated, items };
  }

  async canReadDm(session: SessionIdentity, threadId: string) {
    const thread = await this.getThread(threadId);
    return Boolean(
      thread?.kind === "dm" && session.accountId &&
        thread.participants.includes(session.accountId),
    );
  }

  /**
   * Prepares the idempotency record for a write. A key already used by this
   * caller for a different payload is rejected instead of silently replacing
   * the earlier write.
   */
  private async claimIdempotency(
    session: SessionIdentity,
    tool: string,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<IdempotencyClaim> {
    const digest = await digestPayload(payload);
    const key: Deno.KvKey = [
      "idem",
      session.accountId ?? `session:${session.id}`,
      tool,
      idempotencyKey,
    ];
    const record = (await this.kv.get<IdempotencyRecord>(key)).value;
    if (record && record.digest !== digest) {
      throw new Error(
        "This idempotencyKey was already used for a different write; use a new key.",
      );
    }
    return { key, digest, existing: record };
  }

  /** Adds the idempotency claim to the caller's open atomic commit. */
  private recordIdempotentWrite(
    op: Deno.AtomicOperation,
    claim: IdempotencyClaim,
    written: { messageId: string; threadId: string; created?: boolean },
  ) {
    const record: IdempotencyRecord = { digest: claim.digest, ...written };
    op.check({ key: claim.key, versionstamp: null }).set(claim.key, record);
  }

  /**
   * Re-reads a claim after a failed commit: a competing call with the same key
   * may have won the race, in which case the caller replays its result.
   */
  private async replayIdempotent(claim: IdempotencyClaim) {
    const record = (await this.kv.get<IdempotencyRecord>(claim.key)).value;
    return record
      ? await this.completedIdempotentWrite(record, claim.digest)
      : null;
  }

  /**
   * Returns the currently stored thread and message for a matching prior write,
   * with its original created flag. Throws for a different payload digest, and
   * for a thread or message its ordinary readers no longer expose — a deleted
   * thread, a deleted message, or a thread whose category was deleted. Storage
   * errors propagate.
   */
  private async completedIdempotentWrite(
    record: IdempotencyRecord,
    digest: string,
  ) {
    if (record.digest !== digest) {
      throw new Error(
        "This idempotencyKey was already used for a different write; use a new key.",
      );
    }
    // The ordinary readers decide visibility, not this record: a thread whose
    // category was deleted is hidden everywhere else, so a replay must not
    // resurrect it.
    const thread = await this.getThread(record.threadId);
    const message = await this.getMessage(record.messageId);
    if (!thread || !message) {
      throw new Error(
        "This idempotencyKey already completed a write whose message is no longer available.",
      );
    }
    return { thread, message, created: record.created === true };
  }

  private async resolveMentions(text: string, senderAccountId: string | null) {
    const names = new Set<string>();
    for (const match of text.matchAll(MENTION_RE)) {
      names.add(match[1].normalize("NFKC").toLowerCase());
    }
    if (names.size > MAX_MENTIONS) {
      throw new Error(`A message may mention up to ${MAX_MENTIONS} accounts.`);
    }
    const accounts: PublicAccount[] = [];
    for (const name of names) {
      const account = await this.accounts.resolveUsername(name);
      if (account && account.id !== senderAccountId) accounts.push(account);
    }
    return accounts;
  }

  private async makeMessage(
    session: SessionIdentity,
    threadId: string,
    text: string,
    mentions: PublicAccount[],
  ): Promise<Message> {
    return {
      id: crypto.randomUUID(),
      threadId,
      senderAccountId: session.accountId,
      senderUsername: await this.accounts.sessionUsername(session),
      senderSessionId: session.id,
      text,
      mentions,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
  }
}
