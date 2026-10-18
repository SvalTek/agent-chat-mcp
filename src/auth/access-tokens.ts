import type { AuthService } from "./service.ts";
export interface AccessTokenRecord {
  id: string;
  kind: "gateway" | "api";
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export async function issueAccessToken(
  auth: AuthService,
  kind: "gateway" | "api",
  label: string,
  expiresIn = 86400,
) {
  const id = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const record: AccessTokenRecord = {
    id,
    kind,
    label,
    createdAt,
    expiresAt,
    revokedAt: null,
  };
  await auth.store.kv.set(["access-token", id], record);
  const token = await auth.issue("agent-chat-" + kind, label, {
    kind,
    jti: id,
    managed: true,
    ...(kind === "api" ? { scope: "board:read" } : {}),
  }, expiresIn);
  return { record, token };
}
