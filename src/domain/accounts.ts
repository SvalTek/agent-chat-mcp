import type {
  Account,
  AgentProfile,
  PublicAccount,
  SessionIdentity,
} from "./types.ts";
import { readSettings } from "./settings.ts";
import {
  constantTimeEqual,
  fromHex,
  hashPassword,
  hex,
} from "../auth/passwords.ts";
import { requireAccount } from "./identity.ts";
import type { EventHub } from "./events.ts";
import { decodeCursor, listPage, pageLimit } from "../storage/pagination.ts";
const PBKDF2_ITERATIONS = 600000;
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
const MAX_DESCRIPTION_LENGTH = 500;
function displayAccount(account: Account): PublicAccount {
  return { id: account.id, username: account.username };
}

function agentProfile(account: Account): AgentProfile {
  return {
    id: account.id,
    username: account.username,
    description: account.description ?? null,
    createdAt: account.createdAt,
  };
}

export class Accounts {
  constructor(readonly kv: Deno.Kv, readonly events: EventHub) {}
  /**
   * Registers an unclaimed username or verifies its password, then updates the
   * session identity and invokes its change callback if the account changed.
   * Usernames are NFKC-normalized and trimmed; lookup is case-insensitive.
   * Returns whether registration occurred and publishes a directory update for it.
   *
   * @throws {Error} For invalid usernames, passwords outside 10–256 UTF-16 code
   * units, unavailable accounts, incorrect credentials, or disabled registration.
   * Storage, password hashing, and identity-change callback errors propagate.
   */
  async authenticate(
    session: SessionIdentity,
    usernameInput: string,
    password: string,
  ): Promise<{
    authenticated: true;
    accountId: string;
    username: string;
    registered: boolean;
  }> {
    const username = usernameInput.normalize("NFKC").trim();
    if (!USERNAME_RE.test(username)) {
      throw new Error(
        "Username must be 3–32 ASCII letters, digits, underscores, or hyphens, and start with a letter.",
      );
    }
    if (password.length < 10 || password.length > 256) {
      throw new Error("Password must be between 10 and 256 characters.");
    }
    const normalized = username.toLowerCase();
    const indexKey = ["username", normalized] as const;
    const existingIndex = await this.kv.get<string>(indexKey);

    if (existingIndex.value) {
      const account = await this.kv.get<Account>([
        "account",
        existingIndex.value,
      ]);
      if (!account.value || account.value.suspendedAt) {
        throw new Error(
          "Invalid credentials or account unavailable; choose a different username if you have not registered.",
        );
      }
      const candidate = await hashPassword(
        password,
        fromHex(account.value.salt),
        account.value.iterations,
      );
      if (!constantTimeEqual(candidate, account.value.passwordHash)) {
        throw new Error(
          "Invalid credentials or account unavailable; choose a different username if you have not registered.",
        );
      }
      const changed = session.accountId !== account.value.id;
      session.accountId = account.value.id;
      if (changed) session.onIdentityChanged?.();
      return {
        authenticated: true,
        accountId: account.value.id,
        username: account.value.username,
        registered: false,
      };
    }

    if (!(await readSettings(this.kv)).registrationEnabled) {
      throw new Error("New account registration is disabled by the owner.");
    }
    const id = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
    const account: Account = {
      id,
      username,
      normalizedUsername: normalized,
      salt: hex(salt),
      passwordHash,
      iterations: PBKDF2_ITERATIONS,
      createdAt: new Date().toISOString(),
    };
    const result = await this.kv.atomic()
      .check({ key: indexKey, versionstamp: null })
      .set(indexKey, id)
      .set(["account", id], account)
      .commit();
    if (!result.ok) return await this.authenticate(session, username, password);
    const changed = session.accountId !== id;
    session.accountId = id;
    if (changed) session.onIdentityChanged?.();
    // A new account is a new directory entry.
    this.events.publish({
      publicUris: ["agent-chat://agents"],
      accountUris: {},
    });
    return { authenticated: true, accountId: id, username, registered: true };
  }

  async getAccount(id: string) {
    return (await this.kv.get<Account>(["account", id])).value;
  }

  /**
   * Public agent directory. Accounts appear in stable storage-key order, not
   * name order; suspended accounts are hidden. Pages are not snapshots.
   * The limit defaults to 30 and is floored and clamped to 1–100. A bounded
   * scan may return an empty page with a nextCursor; continue until it is null.
   * Invalid or differently scoped cursors and storage failures propagate.
   */
  async listProfiles(options: { cursor?: string; limit?: number } = {}) {
    const scope = "agent-directory";
    const cursor = decodeCursor<string>(options.cursor, scope);
    return await listPage<AgentProfile>(
      this.kv,
      ["account"],
      scope,
      cursor,
      pageLimit(options.limit),
      (entry) => {
        const account = entry.value as Account;
        return Promise.resolve(
          account.suspendedAt ? null : agentProfile(account),
        );
      },
    );
  }

  /**
   * Returns the public directory profile, or null for a missing or suspended account.
   * Storage failures propagate.
   */
  async getProfile(id: string) {
    const account = await this.getAccount(id);
    return account && !account.suspendedAt ? agentProfile(account) : null;
  }

  async resolveUsername(username: string) {
    const normalized = username.normalize("NFKC").toLowerCase();
    const id = (await this.kv.get<string>(["username", normalized])).value;
    if (!id) return null;
    const account = await this.getAccount(id);
    return account ? displayAccount(account) : null;
  }

  async sessionUsername(session: SessionIdentity) {
    if (!session.accountId) return null;
    return (await this.getAccount(session.accountId))?.username ?? null;
  }

  /**
   * Sets the description shown in the agent directory. An empty description
   * clears it; the account record is replaced under a version check so a
   * concurrent moderation write is never lost. Returns the saved profile and
   * publishes updates for the directory and this account's profile.
   *
   * @throws {Error} If unauthenticated, the trimmed description exceeds 500
   * UTF-16 code units, the account is missing, or three save attempts conflict.
   * Storage failures propagate.
   */
  async updateProfile(
    session: SessionIdentity,
    descriptionInput: string,
  ): Promise<AgentProfile> {
    const accountId = requireAccount(session);
    const description = descriptionInput.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `A profile description is limited to ${MAX_DESCRIPTION_LENGTH} characters.`,
      );
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.kv.get<Account>(["account", accountId]);
      if (!entry.value) throw new Error("Account not found.");
      const updated: Account = { ...entry.value };
      if (description) updated.description = description;
      else delete updated.description;
      const result = await this.kv.atomic()
        .check(entry)
        .set(entry.key, updated)
        .commit();
      if (result.ok) {
        this.events.publish({
          publicUris: [
            "agent-chat://agents",
            `agent-chat://agents/${accountId}`,
          ],
          accountUris: {},
        });
        return agentProfile(updated);
      }
    }
    throw new Error("The account changed while saving the profile; retry.");
  }
}
