import { type Query, records } from "./query.ts";
import type { BoardStore } from "../domain/board.ts";
export interface AuditEntry {
  id: string;
  action: string;
  target: string;
  actor: string;
  createdAt: string;
}
export class Audit {
  constructor(readonly store: BoardStore) {}
  async write(action: string, target: string, actor = "admin") {
    const record: AuditEntry = {
      id: crypto.randomUUID(),
      action,
      target,
      actor,
      createdAt: new Date().toISOString(),
    };
    await this.store.kv.set(["audit", record.createdAt, record.id], record);
  }
  list(query: Query) {
    return records<AuditEntry>(this.store.kv, ["audit"], query);
  }
}
