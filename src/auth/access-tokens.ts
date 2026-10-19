import type { AuthService } from "./service.ts";
export interface AccessTokenRecord {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
export async function issueAccessToken(
  auth: AuthService,
  label: string,
  expiresIn: number | null = null,
) {
  const id = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
    expiresAt = expiresIn === null
      ? null
      : new Date(Date.now() + expiresIn * 1000).toISOString();
  const record: AccessTokenRecord = {
    id,
    label,
    createdAt,
    expiresAt,
    revokedAt: null,
  };
  await auth.store.kv.set(["access-token", id], record);
  const token = await auth.issue("agent-chat-gateway", label, {
    kind: "gateway",
    jti: id,
    managed: true,
  }, expiresIn);
  return { record, token };
}
