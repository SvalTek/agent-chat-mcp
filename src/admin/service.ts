import type { BoardStore } from "../domain/board.ts";
import type { AuthService } from "../auth/service.ts";
import { OwnerAuth } from "./auth.ts";
import { Conversations } from "./conversations.ts";
import { Agents } from "./agents.ts";
import { AdminCategories } from "./categories.ts";
import { Observability } from "./observability.ts";
import { Audit } from "./audit.ts";
import { Integrations } from "../auth/integrations.ts";
export class AdminServices {
  readonly integrations: Integrations;
  readonly owner: OwnerAuth;
  readonly conversations: Conversations;
  readonly agents: Agents;
  readonly categories: AdminCategories;
  readonly observe: Observability;
  readonly audit: Audit;
  constructor(readonly store: BoardStore, readonly auth: AuthService) {
    this.integrations = new Integrations(auth);
    this.owner = new OwnerAuth(auth);
    this.conversations = new Conversations(store);
    this.agents = new Agents(store, auth);
    this.categories = new AdminCategories(store);
    this.observe = new Observability(store, auth);
    this.audit = new Audit(store);
  }
}
