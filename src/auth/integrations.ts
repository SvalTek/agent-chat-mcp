import type { AgentPrincipal, AuthService } from "./service.ts";
import type { Account } from "../domain/types.ts";
import { constantTimeEqual, hashPassword, hex } from "./passwords.ts";
import { AdminError, required } from "../admin/errors.ts";
import { type Query, records } from "../admin/query.ts";
export interface Integration {
  id: string;
  clientId: string;
  accountId: string;
  accessLevel: "admin" | "user";
  tokenHash: string;
  revision: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export type IntegrationView = Omit<Integration, "tokenHash">;
const view = (
  { tokenHash: _tokenHash, ...record }: Integration,
): IntegrationView => record;
async function digest(value: string) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
function token() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export class Integrations {
  constructor(readonly auth: AuthService) {}
  private get kv() {
    return this.auth.store.kv;
  }
  list(query: Query = {}) {
    return records<Integration, IntegrationView>(
      this.kv,
      ["integration"],
      query,
      () => true,
      view,
    );
  }
  async create(
    clientId: string,
    accessLevel: "admin" | "user",
    expiresIn: number,
  ) {
    clientId = clientId.normalize("NFKC").trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,31}$/.test(clientId)) {
      throw new AdminError(
        "clientId must be 3–32 letters, digits, underscores or hyphens, beginning with a letter.",
      );
    }
    const normalized = clientId.toLowerCase(), key = ["username", normalized];
    const nameEntry = await this.kv.get(key);
    if (nameEntry.value) {
      throw new AdminError(
        "That clientId is already used by an agent or integration.",
        409,
      );
    }
    const id = crypto.randomUUID(),
      accountId = crypto.randomUUID(),
      secret = token(),
      salt = crypto.getRandomValues(new Uint8Array(16)),
      createdAt = new Date().toISOString();
    const record: Integration = {
      id,
      clientId,
      accountId,
      accessLevel,
      tokenHash: await digest(secret),
      revision: 0,
      createdAt,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      revokedAt: null,
    };
    const account: Account = {
      id: accountId,
      username: clientId,
      normalizedUsername: normalized,
      salt: hex(salt),
      passwordHash: await hashPassword(token(), salt, 600000),
      iterations: 600000,
      createdAt,
    };
    if (
      !(await this.kv.atomic().check(nameEntry).set(key, accountId).set([
        "account",
        accountId,
      ], account).set(["integration", id], record).set([
        "integration-client",
        normalized,
      ], id).commit()).ok
    ) {
      throw new AdminError(
        "clientId was reserved concurrently. Try another name.",
        409,
      );
    }
    return { record: view(record), clientId, token: secret };
  }
  async update(
    id: string,
    input: {
      accessLevel?: "admin" | "user";
      revoke?: boolean;
      rotate?: boolean;
    },
  ) {
    const entry = await this.kv.get<Integration>(["integration", id]),
      record = required(entry.value, "Integration not found.");
    const secret = input.rotate ? token() : undefined;
    const updated = {
      ...record,
      ...(input.accessLevel ? { accessLevel: input.accessLevel } : {}),
      ...(input.revoke ? { revokedAt: new Date().toISOString() } : {}),
      ...(secret ? { tokenHash: await digest(secret) } : {}),
      revision: record.revision + 1,
    };
    if (
      !(await this.kv.atomic().check(entry).set(entry.key, updated).commit()).ok
    ) throw new AdminError("Integration changed. Retry.", 409);
    for (const session of [...this.auth.sessions.values()]) {
      if (session.integrationId === id) await this.auth.closeSession(session);
    }
    return {
      record: view(updated),
      ...(secret ? { clientId: record.clientId, token: secret } : {}),
    };
  }
  async credentials(clientId: string, secret: string) {
    const id = (await this.kv.get<string>([
      "integration-client",
      clientId.normalize("NFKC").trim().toLowerCase(),
    ])).value;
    const record = id
      ? (await this.kv.get<Integration>(["integration", id])).value
      : null;
    const candidate = await digest(secret);
    if (
      !record || !constantTimeEqual(record.tokenHash, candidate) ||
      record.revokedAt || Date.parse(record.expiresAt) <= Date.now() ||
      (await this.auth.store.getAccount(record.accountId))?.suspendedAt
    ) throw new AdminError("Invalid integration credentials.", 401);
    return record;
  }
  async request(
    request: Request,
  ): Promise<{ record: Integration; principal: AgentPrincipal }> {
    const header = request.headers.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      let clientId = "", secret = "";
      try {
        const decoded = atob(header.slice(6)), colon = decoded.indexOf(":");
        if (colon < 0) throw new Error();
        clientId = decoded.slice(0, colon);
        secret = decoded.slice(colon + 1);
      } catch {
        throw new AdminError("Invalid integration credentials.", 401);
      }
      const record = await this.credentials(clientId, secret);
      return {
        record,
        principal: {
          sessionId: "integration:" + record.id,
          accountId: record.accountId,
          username: record.clientId,
          revision: record.revision,
          integrationId: record.id,
          accessLevel: record.accessLevel,
        },
      };
    }
    if (header.startsWith("Bearer ")) {
      const principal = await this.auth.verifyAgent(header.slice(7));
      if (!principal.integrationId) {
        throw new AdminError("Integration credentials required.", 401);
      }
      const record = required(
        (await this.kv.get<Integration>([
          "integration",
          principal.integrationId,
        ])).value,
      );
      return { record, principal };
    }
    throw new AdminError("Integration credentials required.", 401);
  }
  async exchange(clientId: string, secret: string) {
    const record = await this.credentials(clientId, secret);
    return {
      ...await this.auth.openIntegration(record),
      clientId: record.clientId,
      accessLevel: record.accessLevel,
    };
  }
}
