import type { Message, SessionIdentity } from "./types.ts";
import { EventHub } from "./events.ts";
import { requireAccount } from "./identity.ts";
import {
  decodeCursor,
  encodeReadCursor,
  listPage,
  pageLimit,
} from "../storage/pagination.ts";
import { Messages } from "./messages.ts";
export class Inbox {
  constructor(
    readonly kv: Deno.Kv,
    readonly messages: Messages,
    readonly events: EventHub,
  ) {}
  async listInbox(
    session: SessionIdentity,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const accountId = requireAccount(session);
    const scope = `inbox:${accountId}`;
    const cursor = decodeCursor<string>(options.cursor, scope);
    const page = await listPage<
      {
        messageId: string;
        threadId: string;
        kind: string;
        readCursor: string;
        read: boolean;
        message: Message | null;
      }
    >(
      this.kv,
      ["inbox", accountId],
      scope,
      cursor,
      pageLimit(options.limit),
      async (entry) => {
        const stamp = String(entry.key.at(-1));
        const value = entry.value as {
          messageId: string;
          threadId: string;
          kind: string;
        };
        const readThrough =
          (await this.kv.get<string>(["inbox-read", accountId])).value;
        const message = await this.messages.getMessage(value.messageId);
        return {
          ...value,
          message,
          readCursor: encodeReadCursor(accountId, stamp),
          read: Boolean(readThrough && stamp <= readThrough),
        };
      },
    );
    return page;
  }

  async markInboxRead(session: SessionIdentity, readCursor: string) {
    const accountId = requireAccount(session);
    let value: { accountId: string; stamp: string } | undefined;
    try {
      value = decodeCursor<{ accountId: string; stamp: string }>(
        readCursor,
        `inbox-read:${accountId}`,
      );
    } catch {
      throw new Error(
        "Invalid inbox read cursor. Use the readCursor supplied on the last inbox item you processed, not a message or thread ID. An empty inbox needs no acknowledgment.",
      );
    }
    if (!value || value.accountId !== accountId || !value.stamp) {
      throw new Error("Invalid inbox read cursor.");
    }
    const indexEntry = await this.kv.get(["inbox", accountId, value.stamp]);
    if (!indexEntry.value) {
      throw new Error(
        "Inbox cursor does not belong to this account or no longer exists.",
      );
    }
    for (;;) {
      const current = await this.kv.get<string>(["inbox-read", accountId]);
      if (current.value && current.value >= value.stamp) {
        return { markedThrough: value.stamp, alreadyRead: true };
      }
      const result = await this.kv.atomic()
        .check(current, indexEntry)
        .set(["inbox-read", accountId], value.stamp)
        .commit();
      if (result.ok) {
        this.events.publish({
          publicUris: [],
          accountUris: { [accountId]: ["agent-chat://inbox/me"] },
        });
        return { markedThrough: value.stamp, alreadyRead: false };
      }
    }
  }
}
