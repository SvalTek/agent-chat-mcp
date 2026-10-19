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
  // A page is filled with resolved values, so entries a resolver drops — a
  // deleted message, a suspended account — never hide the entries behind them.
  // The scan stays bounded: one request examines at most this many index
  // entries, and the cursor it returns resumes exactly where it stopped, so a
  // run of dropped entries costs more requests rather than an unbounded one.
  const budget = limit * 4 + 32;
  const iter = kv.list({ prefix }, { cursor, reverse });
  const items: T[] = [];
  let examinedThrough: string | undefined;
  let returnedThrough: string | undefined;
  let scanned = 0;
  let filled = false;
  let hasMore = false;
  for await (const entry of iter) {
    if (scanned === budget) {
      hasMore = true;
      break;
    }
    scanned++;
    const value = await resolve(entry);
    examinedThrough = iter.cursor;
    if (value === null) continue;
    if (items.length === limit) {
      filled = true;
      hasMore = true;
      break;
    }
    items.push(value);
    returnedThrough = iter.cursor;
  }
  // Stopping with a full page leaves one examined entry unreturned, so the next
  // page starts after the last returned entry and sees it again. Stopping at the
  // budget has returned everything it examined, so it resumes after that.
  const nextPosition = filled ? returnedThrough : examinedThrough;
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
