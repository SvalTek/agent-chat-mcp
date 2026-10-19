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
import { Follows, MAX_THREAD_FOLLOWERS } from "./follows.ts";
import { hex } from "../auth/passwords.ts";
const MENTION_RE = /(?<![\w@])@([A-Za-z][A-Za-z0-9_-]{2,31})(?![A-Za-z0-9_-])/g;
const MAX_MENTIONS = 20;
const MAX_TEXT_LENGTH = 20000;

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
    // The author follows the thread they started, so later replies reach them.
    if (session.accountId) {
      this.follows.setFollower(op, threadId, session.accountId, now);
    }
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
    this.events.publish({
      publicUris: [
        "agent-chat://categories",
        `agent-chat://categories/${categoryId}/threads`,
        `agent-chat://threads/${threadId}`,
      ],
      accountUris: Object.fromEntries(
        recipientIds.map((id) => [id, ["agent-chat://inbox/me"]]),
      ),
    });
    return { thread, message };
  }

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
    const followerIds = await this.follows.followerIds(threadId);
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
    for (const accountId of followerIds) {
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
    // Replying follows the thread, unless the follower index is already full.
    if (
      session.accountId && !followerIds.includes(session.accountId) &&
      followerIds.length < MAX_THREAD_FOLLOWERS
    ) {
      this.follows.setFollower(op, threadId, session.accountId, now);
    }
    if (idempotency) {
      this.recordIdempotentWrite(op, idempotency, { messageId, threadId });
    }
    const result = await op.commit();
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
    const recipientIds = [...recipients];
    this.events.publish({
      publicUris: [
        `agent-chat://threads/${threadId}`,
        `agent-chat://categories/${threadEntry.value.categoryId}/threads`,
      ],
      accountUris: Object.fromEntries(
        recipientIds.map((id) => [id, ["agent-chat://inbox/me"]]),
      ),
    });
    return message;
  }

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

  private async completedIdempotentWrite(
    record: IdempotencyRecord,
    digest: string,
  ) {
    if (record.digest !== digest) {
      throw new Error(
        "This idempotencyKey was already used for a different write; use a new key.",
      );
    }
    const thread = (await this.kv.get<Thread>(["thread", record.threadId]))
      .value;
    const message = (await this.kv.get<Message>(["message", record.messageId]))
      .value;
    if (!thread || thread.deletedAt || !message || message.deletedAt) {
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
