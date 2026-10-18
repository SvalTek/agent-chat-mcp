import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { OwnerAuth, OwnerSession } from "../../admin/auth.ts";
import { AdminError } from "../../admin/errors.ts";
import type { Integrations } from "../../auth/integrations.ts";
export type DashboardEnv = { Variables: { owner: OwnerSession } };
export const OWNER_COOKIE = "agent_chat_owner";
export function returnPath(value: string | undefined) {
  return value && value.startsWith("/") && !value.startsWith("//") &&
      !/[\\\r\n]/.test(value) && !value.startsWith("/login")
    ? value
    : "/";
}
export function ownerCookie(c: Context, token: string) {
  setCookie(c, OWNER_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure:
      new URL(Deno.env.get("AGENT_CHAT_PUBLIC_URL") ?? c.req.url).protocol ===
        "https:",
    path: "/",
    maxAge: 28800,
  });
}
export function clearOwnerCookie(c: Context) {
  deleteCookie(c, OWNER_COOKIE, { path: "/" });
}
export function requireOwner(
  auth: OwnerAuth,
  api = false,
  integrations?: Integrations,
): MiddlewareHandler<DashboardEnv> {
  return async (c, next) => {
    let owner: OwnerSession;
    if (api && c.req.header("authorization") && integrations) {
      let record;
      try {
        record = (await integrations.request(c.req.raw)).record;
      } catch {
        return c.json({ error: "Invalid integration credentials." }, 401);
      }
      if (record.accessLevel !== "admin") {
        return c.json({ error: "Admin integration access required." }, 403);
      }
      owner = {
        id: "integration:" + record.id,
        username: record.clientId,
        csrf: "",
        revision: record.revision,
        expiresAt: Date.parse(record.expiresAt),
        token: "",
      };
      c.set("owner", owner);
      await next();
      return;
    }
    try {
      owner = await auth.verify(getCookie(c, OWNER_COOKIE) ?? "");
    } catch {
      if (api) return c.json({ error: "Sign in to continue." }, 401);
      return c.redirect(
        "/login?returnTo=" +
          encodeURIComponent(c.req.path + (new URL(c.req.url).search)),
        303,
      );
    }
    c.set("owner", owner);
    if (
      api && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("x-csrf-token") !== owner.csrf
    ) throw new AdminError("Invalid CSRF token. Reload the page.", 403);
    await next();
  };
}
