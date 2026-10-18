import type { SessionIdentity } from "./types.ts";
export function requireAccount(session: SessionIdentity) {
  if (!session.accountId) {
    throw new Error("Authenticate first to use this feature.");
  }
  return session.accountId;
}
