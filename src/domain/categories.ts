import type { Category, SessionIdentity } from "./types.ts";
import { EventHub } from "./events.ts";
import { requireAccount } from "./identity.ts";
import { decodeCursor, listPage, pageLimit } from "../storage/pagination.ts";

export class Categories {
  constructor(readonly kv: Deno.Kv, readonly events: EventHub) {}
  async createCategory(session: SessionIdentity, nameInput: string) {
    const accountId = requireAccount(session);
    const name = nameInput.trim();
    if (!name || name.length > 80) {
      throw new Error("Category names must contain 1–80 characters.");
    }
    const id = crypto.randomUUID();
    const category: Category = {
      id,
      name,
      normalizedName: name.normalize("NFKC").toLowerCase(),
      creatorAccountId: accountId,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    const result = await this.kv.atomic()
      .set(["category", id], category)
      .set(["category-list", category.createdAt, id], id)
      .commit();
    if (!result.ok) throw new Error("Category could not be created; retry.");
    this.events.publish({
      publicUris: ["agent-chat://categories"],
      accountUris: {},
    });
    return category;
  }

  async renameCategory(
    session: SessionIdentity,
    categoryId: string,
    nameInput: string,
  ) {
    const accountId = requireAccount(session);
    const entry = await this.kv.get<Category>(["category", categoryId]);
    if (!entry.value || entry.value.deletedAt || entry.value.purgingAt) {
      throw new Error("Category not found.");
    }
    if (entry.value.creatorAccountId !== accountId) {
      throw new Error("Only the category creator can rename it.");
    }
    if (entry.value.archivedAt) {
      throw new Error("Archived categories cannot be renamed.");
    }
    const name = nameInput.trim();
    if (!name || name.length > 80) {
      throw new Error("Category names must contain 1–80 characters.");
    }
    const updated = {
      ...entry.value,
      name,
      normalizedName: name.normalize("NFKC").toLowerCase(),
    };
    const result = await this.kv.atomic().check(entry).set(entry.key, updated)
      .commit();
    if (!result.ok) {
      throw new Error("Category changed concurrently; reload it and retry.");
    }
    this.events.publish({
      publicUris: [
        "agent-chat://categories",
        `agent-chat://categories/${categoryId}/threads`,
      ],
      accountUris: {},
    });
    return updated;
  }

  async archiveCategory(session: SessionIdentity, categoryId: string) {
    const accountId = requireAccount(session);
    const entry = await this.kv.get<Category>(["category", categoryId]);
    if (!entry.value || entry.value.deletedAt || entry.value.purgingAt) {
      throw new Error("Category not found.");
    }
    if (entry.value.creatorAccountId !== accountId) {
      throw new Error("Only the category creator can archive it.");
    }
    if (entry.value.archivedAt) return entry.value;
    const updated = { ...entry.value, archivedAt: new Date().toISOString() };
    const result = await this.kv.atomic().check(entry).set(entry.key, updated)
      .commit();
    if (!result.ok) {
      throw new Error("Category changed concurrently; reload it and retry.");
    }
    this.events.publish({
      publicUris: [
        "agent-chat://categories",
        `agent-chat://categories/${categoryId}/threads`,
      ],
      accountUris: {},
    });
    return updated;
  }

  async getCategory(categoryId: string) {
    const category =
      (await this.kv.get<Category>(["category", categoryId])).value;
    return category && !category.deletedAt && !category.purgingAt
      ? category
      : null;
  }

  async listCategories(options: { cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(options.limit);
    const scope = "categories";
    const cursor = decodeCursor<string>(options.cursor, scope);
    return await listPage<Category>(
      this.kv,
      ["category-list"],
      scope,
      cursor,
      limit,
      async (entry) => {
        const id = String(entry.value);
        return await this.getCategory(id);
      },
    );
  }
}
