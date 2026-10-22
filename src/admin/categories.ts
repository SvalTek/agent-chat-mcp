import type { BoardStore, Category, Thread } from "../domain/board.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
import { purgeCategory } from "./purge.ts";
export class AdminCategories {
  constructor(readonly store: BoardStore) {}
  async list(query: Query = {}) {
    const page = await records<Category>(
      this.store.kv,
      ["category"],
      query,
      () => true,
    );
    const ids = new Set(page.items.map((category) => category.id));
    const counts = new Map<string, number>();
    for await (
      const entry of this.store.kv.list<Thread>({ prefix: ["thread"] })
    ) {
      const thread = entry.value;
      if (
        thread.categoryId && ids.has(thread.categoryId) && !thread.deletedAt
      ) {
        counts.set(thread.categoryId, (counts.get(thread.categoryId) ?? 0) + 1);
      }
    }
    return {
      ...page,
      items: page.items.map((category) => ({
        ...category,
        conversationCount: counts.get(category.id) ?? 0,
      })),
    };
  }
  async create(name: string) {
    if (!name.trim() || name.length > 80) {
      throw new AdminError("Use a name between 1 and 80 characters.");
    }
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const record: Category = {
      id,
      name: name.trim(),
      normalizedName: name.trim().normalize("NFKC").toLowerCase(),
      creatorAccountId: "owner",
      createdAt,
      archivedAt: null,
    };
    const result = await this.store.kv.atomic().set(["category", id], record)
      .set(["category-list", createdAt, id], id).commit();
    if (!result.ok) throw new AdminError("Category creation failed.", 409);
    this.changed();
    return record;
  }
  async update(id: string, input: { name?: string; archived?: boolean }) {
    const entry = await this.store.kv.get<Category>(["category", id]),
      old = required(entry.value);
    if (old.deletedAt || old.purgingAt) {
      throw new AdminError("Category not found.", 404);
    }
    const updated = { ...old };
    if (input.name !== undefined) {
      if (!input.name.trim() || input.name.length > 80) {
        throw new AdminError("Use a name between 1 and 80 characters.");
      }
      updated.name = input.name.trim();
      updated.normalizedName = input.name.trim().normalize("NFKC")
        .toLowerCase();
    }
    if (input.archived !== undefined) {
      updated.archivedAt = input.archived ? new Date().toISOString() : null;
    }
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, updated)
        .commit()).ok
    ) throw new AdminError("Category changed. Retry.", 409);
    this.changed();
    return updated;
  }
  /**
   * Soft-deletes an archived category with no undeleted conversations and
   * publishes category and feed updates. Returns { deleted: true }.
   * Throws AdminError for a missing/deleted category (404), or a category that
   * is unarchived, still has conversations, or changes concurrently (409).
   * Storage errors propagate.
   */
  async remove(id: string) {
    return await purgeCategory(this.store, id);
  }
  /**
   * Publishes a category-list update and any additional public resource URIs.
   */
  changed(extraUris: string[] = []) {
    this.store.events.publish({
      publicUris: ["agent-chat://categories", ...extraUris],
      accountUris: {},
    });
  }
}
