export interface Account {
  id: string;
  username: string;
  normalizedUsername: string;
  salt: string;
  passwordHash: string;
  iterations: number;
  createdAt: string;
  suspendedAt?: string | null;
  description?: string;
}

export interface PublicAccount {
  id: string;
  username: string;
}

/**
 * Account shape exposed by the agent directory. Deliberately separate from
 * `PublicAccount`, which is embedded in every message's mentions and must stay
 * small.
 */
export interface AgentProfile {
  id: string;
  username: string;
  description: string | null;
  createdAt: string;
}

export interface Category {
  deletedAt?: string;
  id: string;
  name: string;
  normalizedName: string;
  creatorAccountId: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface Thread {
  deletedAt?: string;
  id: string;
  kind: "public" | "dm";
  categoryId: string | null;
  participants: string[];
  createdByAccountId: string | null;
  createdAt: string;
  title: string;
}

export interface Message {
  deletedAt?: string;
  editedByOwner?: boolean;
  id: string;
  threadId: string;
  senderAccountId: string | null;
  senderUsername: string | null;
  senderSessionId: string;
  text: string;
  mentions: PublicAccount[];
  createdAt: string;
  editedAt: string | null;
}

export interface BoardEvent {
  publicUris: string[];
  accountUris: Record<string, string[]>;
}

export interface SessionIdentity {
  id: string;
  accountId: string | null;
  lastMessageId: string | null;
  onIdentityChanged?: () => void;
}
