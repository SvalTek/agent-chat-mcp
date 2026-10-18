import { decodeCursor, encodeCursor } from "../storage/pagination.ts";
import { AdminError } from "./errors.ts";
export interface Query {
  cursor?: string;
  limit?: number;
  q?: string;
  kind?: string;
  agentId?: string;
  categoryId?: string;
}
export async function records<T, R = T>(
  kv: Deno.Kv,
  prefix: Deno.KvKey,
  query: Query = {},
  filter: (value: T) => boolean | Promise<boolean> = () => true,
  project: (value: T) => R | Promise<R> = (v) => v as unknown as R,
  applySearch = true,
) {
  const limit = Math.max(1, Math.min(100, query.limit ?? 30));
  const scope = JSON.stringify([
    prefix,
    query.q ?? "",
    query.kind ?? "",
    query.agentId ?? "",
    query.categoryId ?? "",
  ]);
  const cursor = decodeCursor<string>(query.cursor, scope);
  const iterator = kv.list<T>({ prefix }, {
    cursor,
    limit: 1000,
    reverse: prefix[0] === "audit",
  });
  const items: R[] = [];
  let next: string | undefined;
  let scanned = 0;
  try {
    for await (const entry of iterator) {
      scanned++;
      next = iterator.cursor;
      if (await filter(entry.value)) {
        const value = await project(entry.value);
        if (
          !applySearch || !query.q ||
          JSON.stringify(value).toLowerCase().includes(query.q.toLowerCase())
        ) items.push(value);
      }
      if (items.length >= limit) break;
    }
  } catch {
    throw new AdminError("Invalid pagination cursor.");
  }
  return {
    items,
    nextCursor: (items.length === limit || scanned === 1000) && next
      ? encodeCursor({ scope, value: next })
      : null,
  };
}
export async function count(kv: Deno.Kv, prefix: Deno.KvKey) {
  let total = 0;
  for await (const entry of kv.list<{ deletedAt?: string }>({ prefix })) {
    if (!entry.value.deletedAt) total++;
  }
  return total;
}
