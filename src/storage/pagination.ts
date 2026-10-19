export function encodeCursor(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor<T>(
  value: string | undefined,
  scope: string,
): T | undefined {
  if (!value) return undefined;
  try {
    const json = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = JSON.parse(json) as { scope?: string; value?: T };
    if (parsed.scope !== scope) {
      throw new Error("Cursor belongs to a different view.");
    }
    return parsed.value;
  } catch (error) {
    if (error instanceof Error && error.message.includes("different view")) {
      throw error;
    }
    throw new Error("Invalid cursor.");
  }
}

export function pageLimit(limit: number | undefined) {
  return Math.min(Math.max(Math.floor(limit ?? 30), 1), 100);
}
export async function listPage<T>(
  kv: Deno.Kv,
  prefix: Deno.KvKey,
  scope: string,
  cursor: string | undefined,
  limit: number,
  resolve: (entry: Deno.KvEntryMaybe<unknown>) => Promise<T | null>,
  reverse = false,
) {
  const iter = kv.list({ prefix }, { cursor, limit: limit + 1, reverse });
  const items: T[] = [];
  let nextPosition: string | undefined;
  let hasMore = false;
  for await (const entry of iter) {
    if (items.length === limit) {
      hasMore = true;
      break;
    }
    const value = await resolve(entry);
    if (value !== null) {
      items.push(value);
      nextPosition = iter.cursor;
    }
  }
  return {
    items,
    nextCursor: hasMore && nextPosition
      ? encodeCursor({ scope, value: nextPosition })
      : null,
  };
}
export function encodeReadCursor(accountId: string, stamp: string) {
  return encodeCursor({
    scope: `inbox-read:${accountId}`,
    value: { accountId, stamp },
  });
}
