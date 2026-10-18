import { jwtVerify, SignJWT } from "jose";
import type { BoardStore, SessionIdentity } from "../domain/board.ts";

export interface AgentPrincipal {
  sessionId: string;
  accountId: string | null;
  username: string | null;
  revision: number;
  createdAt?: string;
  lastSeenAt?: string;
  integrationId?: string;
  integrationRevision?: number;
  accessLevel?: "admin" | "user";
  clientName?: string;
  clientVersion?: string;
}
export interface AuthOptions {
  secret: string;
  issuer?: string;
  ttlSeconds?: number;
  requireGateway?: boolean;
}

export class AuthService {
  readonly sessions = new Map<string, AgentPrincipal>();
  private readonly expires = new Map<string, number>();
  readonly changed = new Set<(sessionId: string) => void>();
  readonly key: Uint8Array;
  readonly issuer: string;
  readonly ttl: number;
  constructor(readonly store: BoardStore, readonly options: AuthOptions) {
    if (options.secret.length < 32) {
      throw new Error("JWT secret must contain at least 32 characters.");
    }
    this.key = new TextEncoder().encode(options.secret);
    this.issuer = options.issuer ?? "agent-chat-mcp";
    this.ttl = options.ttlSeconds ?? 3600;
    if (!Number.isInteger(this.ttl) || this.ttl < 60 || this.ttl > 86400) {
      throw new Error("Token lifetime must be 60–86400 seconds.");
    }
  }
  async issue(
    audience: string | string[],
    subject: string,
    claims: Record<string, unknown>,
    ttl = this.ttl,
  ) {
    return await new SignJWT(claims).setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
    })
      .setIssuer(this.issuer).setAudience(audience).setSubject(subject)
      .setIssuedAt().setExpirationTime(String(ttl) + "s").sign(this.key);
  }
  async verifyPurpose(token: string, audience: string) {
    const payload = (await jwtVerify(token, this.key, {
      algorithms: ["HS256"],
      issuer: this.issuer,
      audience,
    })).payload;
    if (payload.managed === true) {
      const record = typeof payload.jti === "string"
        ? (await this.store.kv.get<{ revokedAt: string | null }>([
          "access-token",
          payload.jti,
        ])).value
        : null;
      if (!record || record.revokedAt) throw new Error("Access token revoked.");
    }
    if (typeof payload.integrationId === "string") {
      const record = (await this.store.kv.get<
        { revokedAt: string | null; expiresAt: string; revision: number }
      >(["integration", payload.integrationId])).value;
      if (
        !record || record.revokedAt ||
        Date.parse(record.expiresAt) <= Date.now() ||
        payload.integrationRevision !== record.revision
      ) throw new Error("Integration revoked, expired, or changed.");
    }
    return payload;
  }
  async openSession(gatewayToken?: string) {
    if (this.options.requireGateway) {
      const payload = await this.verifyPurpose(
        gatewayToken ?? "",
        "agent-chat-gateway",
      );
      if (payload.kind !== "gateway") {
        throw new Error("Gateway credential required.");
      }
    }
    await this.cleanupExpiredSessions();
    if (this.sessions.size >= 2000) {
      throw new Error("Board session limit reached.");
    }
    const principal: AgentPrincipal = {
      sessionId: crypto.randomUUID(),
      accountId: null,
      username: null,
      revision: 0,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.sessions.set(principal.sessionId, principal);
    return await this.tokenResult(principal);
  }
  async cleanupExpiredSessions() {
    for (const [id, expires] of this.expires) {
      if (expires <= Date.now()) {
        const principal = this.sessions.get(id);
        if (principal) await this.closeSession(principal);
      }
    }
  }
  async verifyAgent(token: string) {
    const payload = await this.verifyPurpose(token, "agent-chat-mcp");
    const principal = typeof payload.sid === "string"
      ? this.sessions.get(payload.sid)
      : undefined;
    if (
      !principal || payload.rev !== principal.revision ||
      payload.kind !== (principal.accountId ? "board-user" : "anonymous") ||
      payload.sub !== (principal.accountId ?? principal.sessionId)
    ) {
      throw new Error(
        "Session expired or identity changed; reconnect and authenticate again.",
      );
    }
    if (
      principal.accountId &&
      (await this.store.getAccount(principal.accountId))?.suspendedAt
    ) throw new Error("Account suspended.");
    principal.lastSeenAt = new Date().toISOString();
    return { ...principal };
  }
  identity(principal: AgentPrincipal): SessionIdentity {
    return {
      id: principal.sessionId,
      accountId: principal.accountId,
      lastMessageId: null,
    };
  }
  /** Self-reported labels for diagnostics only; never used for authorization. */
  identifyClient(principal: AgentPrincipal, request: Request) {
    const clean = (value: string | null) =>
      value?.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 100);
    const clientName = clean(request.headers.get("x-agent-chat-client-name"));
    const clientVersion = clean(
      request.headers.get("x-agent-chat-client-version"),
    );
    const metadata = {
      ...(clientName ? { clientName } : {}),
      ...(clientVersion ? { clientVersion } : {}),
    };
    Object.assign(principal, metadata);
    const session = this.sessions.get(principal.sessionId);
    if (session) Object.assign(session, metadata);
    return principal;
  }
  async authenticate(
    principal: AgentPrincipal,
    username: string,
    password: string,
  ) {
    if (principal.integrationId) {
      throw new Error("Integration identity is fixed to its clientId.");
    }
    const session = this.identity(principal);
    const result = await this.store.authenticate(session, username, password);
    if (
      this.sessions.get(principal.sessionId)?.revision !== principal.revision
    ) throw new Error("Identity changed concurrently; retry authentication.");
    const next = {
      ...principal,
      accountId: result.accountId,
      username: result.username,
      revision: principal.revision + 1,
    };
    this.sessions.set(next.sessionId, next);
    for (const listener of this.changed) listener(next.sessionId);
    return { ...await this.tokenResult(next), status: result };
  }
  async refresh(principal: AgentPrincipal) {
    return await this.tokenResult(principal);
  }
  async openIntegration(
    record: {
      id: string;
      accountId: string;
      clientId: string;
      revision: number;
      accessLevel: "admin" | "user";
    },
  ) {
    await this.cleanupExpiredSessions();
    if (this.sessions.size >= 2000) {
      throw new Error("Board session limit reached.");
    }
    const now = new Date().toISOString();
    const principal: AgentPrincipal = {
      sessionId: crypto.randomUUID(),
      accountId: record.accountId,
      username: record.clientId,
      revision: 0,
      integrationId: record.id,
      integrationRevision: record.revision,
      accessLevel: record.accessLevel,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(principal.sessionId, principal);
    return await this.tokenResult(principal);
  }
  async closeSession(principal: AgentPrincipal) {
    this.sessions.delete(principal.sessionId);
    this.expires.delete(principal.sessionId);
    for (const listener of this.changed) listener(principal.sessionId);
    await this.store.kv.delete(["session-last-message", principal.sessionId]);
  }
  private async tokenResult(principal: AgentPrincipal) {
    this.expires.set(principal.sessionId, Date.now() + this.ttl * 1000);
    return {
      accessToken: await this.issue(
        principal.integrationId
          ? (principal.accessLevel === "admin"
            ? ["agent-chat-mcp", "agent-chat-admin-api", "agent-chat-api"]
            : ["agent-chat-mcp", "agent-chat-api"])
          : "agent-chat-mcp",
        principal.accountId ?? principal.sessionId,
        {
          sid: principal.sessionId,
          rev: principal.revision,
          kind: principal.accountId ? "board-user" : "anonymous",
          ...(principal.integrationId
            ? {
              integrationId: principal.integrationId,
              integrationRevision: principal.integrationRevision,
              accessLevel: principal.accessLevel,
            }
            : {}),
        },
      ),
      expiresIn: this.ttl,
      sessionId: principal.sessionId,
    };
  }
}
export function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ") || !value.slice(7)) {
    throw new Error("Bearer token required.");
  }
  return value.slice(7);
}
