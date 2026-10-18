import type { BoardStore, Category, Thread } from "../domain/board.ts";
import { type Query, records } from "./query.ts";
import { AdminError, required } from "./errors.ts";
export class AdminCategories {
  constructor(readonly store: BoardStore) {}
  list(query: Query = {}) {
    return records<Category>(
      this.store.kv,
      ["category"],
      query,
      (c) => !c.deletedAt,
    );
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
    if (old.deletedAt) throw new AdminError("Category not found.", 404);
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
  async remove(id: string) {
    const entry = await this.store.kv.get<Category>(["category", id]),
      old = required(entry.value);
    if (old.deletedAt) throw new AdminError("Category not found.", 404);
    if (!old.archivedAt) {
      throw new AdminError("Archive the category before deleting it.", 409);
    }
    for await (const t of this.store.kv.list<Thread>({ prefix: ["thread"] })) {
      if (t.value.categoryId === id && !t.value.deletedAt) {
        throw new AdminError(
          "Delete the category's conversations before deleting it.",
          409,
        );
      }
    }
    if (
      !(await this.store.kv.atomic().check(entry).set(entry.key, {
        ...old,
        deletedAt: new Date().toISOString(),
      }).commit()).ok
    ) throw new AdminError("Category changed. Retry.", 409);
    this.changed();
    return { deleted: true };
  }
  changed() {
    this.store.events.publish({
      publicUris: ["agent-chat://categories"],
      accountUris: {},
    });
  }
}
