import { AuthService } from "../auth/service.ts";
import {
  constantTimeEqual,
  fromHex,
  hashPassword,
  hex,
} from "../auth/passwords.ts";
import { AdminError } from "./errors.ts";
export interface OwnerRecord {
  username: string;
  salt: string;
  passwordHash: string;
  iterations: number;
  revision: number;
  defaultPassword: boolean;
}
export interface OwnerSession {
  id: string;
  username: string;
  csrf: string;
  revision: number;
  expiresAt: number;
  token: string;
}
export class OwnerAuth {
  private attempts: number[] = [];
  constructor(readonly auth: AuthService) {}
  private get kv() {
    return this.auth.store.kv;
  }
  async owner(): Promise<OwnerRecord> {
    const entry = await this.kv.get<OwnerRecord>(["owner"]);
    if (entry.value) return entry.value;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const value: OwnerRecord = {
      username: "admin",
      salt: hex(salt),
      passwordHash: await hashPassword("change-me", salt, 600000),
      iterations: 600000,
      revision: 0,
      defaultPassword: true,
    };
    const result = await this.kv.atomic().check(entry).set(entry.key, value)
      .commit();
    return result.ok ? value : await this.owner();
  }
  async login(username: string, password: string): Promise<OwnerSession> {
    this.attempts = this.attempts.filter((t) => Date.now() - t < 60000);
    if (this.attempts.length >= 10) {
      throw new AdminError(
        "Too many login attempts. Try again in a minute.",
        429,
      );
    }
    const owner = await this.owner();
    const candidate = await hashPassword(
      password,
      fromHex(owner.salt),
      owner.iterations,
    );
    if (
      !constantTimeEqual(username, owner.username) ||
      !constantTimeEqual(candidate, owner.passwordHash)
    ) {
      this.attempts.push(Date.now());
      throw new AdminError("Invalid username or password.", 401);
    }
    this.attempts = [];
    const id = crypto.randomUUID(),
      csrf = crypto.randomUUID(),
      expiresAt = Date.now() + 28800000;
    const session = {
      id,
      username: owner.username,
      csrf,
      revision: owner.revision,
      expiresAt,
    };
    await this.kv.set(["owner-session", id], session, { expireIn: 28800000 });
    return {
      ...session,
      token: await this.auth.issue("agent-chat-owner", owner.username, {
        kind: "owner",
        sid: id,
        rev: owner.revision,
      }, 28800),
    };
  }
  async verify(token: string): Promise<OwnerSession> {
    try {
      const claims = await this.auth.verifyPurpose(token, "agent-chat-owner");
      if (claims.kind !== "owner" || typeof claims.sid !== "string") {
        throw new Error();
      }
      const session = (await this.kv.get<Omit<OwnerSession, "token">>([
        "owner-session",
        claims.sid,
      ])).value;
      const owner = await this.owner();
      if (
        !session || session.expiresAt <= Date.now() ||
        session.revision !== owner.revision || claims.rev !== owner.revision ||
        claims.sub !== owner.username
      ) throw new Error();
      return { ...session, token };
    } catch {
      throw new AdminError("Sign in to continue.", 401);
    }
  }
  async logout(session: OwnerSession) {
    await this.kv.delete(["owner-session", session.id]);
  }
  async password(
    session: OwnerSession,
    currentPassword: string,
    newPassword: string,
  ) {
    if (newPassword.length < 10 || newPassword.length > 256) {
      throw new AdminError("Use a password between 10 and 256 characters.");
    }
    const entry = await this.kv.get<OwnerRecord>(["owner"]),
      owner = entry.value!;
    if (
      !constantTimeEqual(
        await hashPassword(
          currentPassword,
          fromHex(owner.salt),
          owner.iterations,
        ),
        owner.passwordHash,
      )
    ) throw new AdminError("Current password is incorrect.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const updated = {
      ...owner,
      salt: hex(salt),
      passwordHash: await hashPassword(newPassword, salt, 600000),
      revision: owner.revision + 1,
      defaultPassword: false,
    };
    if (
      !(await this.kv.atomic().check(entry).set(entry.key, updated).commit()).ok
    ) throw new AdminError("Owner credentials changed. Sign in again.", 409);
    await this.logout(session);
    return await this.login(owner.username, newPassword);
  }
}
