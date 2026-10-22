import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Child } from "hono/jsx";
import type { AdminServices } from "../../admin/service.ts";
import { readSettings } from "../../domain/settings.ts";
import { type Query, records } from "../../admin/query.ts";
import type { AccessTokenRecord } from "../../auth/access-tokens.ts";
import { AdminError } from "../../admin/errors.ts";
import {
  type DashboardEnv,
  ownerCookie,
  requireOwner,
  returnPath,
} from "../middleware/auth.ts";
import { AppLayout } from "../components/layout.tsx";
import { LoginPage } from "../pages/login.tsx";
import { OverviewPage } from "../pages/overview.tsx";
import { ActivityPage } from "../pages/activity.tsx";
import { AgentsPage } from "../pages/agents.tsx";
import { CategoriesPage } from "../pages/categories.tsx";
import { ConversationsPage } from "../pages/conversations.tsx";
import { SessionsPage } from "../pages/sessions.tsx";
import { GatewayAccessPage, IntegrationsPage } from "../pages/access.tsx";
import { AgentPage, ConversationPage } from "../pages/detail.tsx";
import { SettingsPage } from "../pages/settings.tsx";
import { LogsPage } from "../pages/logs.tsx";
import { Empty, PageHeader } from "../components/primitives.tsx";
import { pageOptions } from "../../http/query.ts";
const query = (url: URL): Query => ({
  ...pageOptions(url),
  q: z.string().max(200).parse(url.searchParams.get("q") ?? ""),
  kind: url.searchParams.get("kind") ?? undefined,
  categoryId: url.searchParams.get("categoryId") ?? undefined,
  agentId: url.searchParams.get("agentId") ?? undefined,
  status: url.searchParams.get("status") ?? undefined,
});
function html(_c: Context, node: Child, status = 200) {
  return new Response("<!doctype html>" + String(node), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    },
  });
}
export function dashboardPages(admin: AdminServices) {
  const app = new Hono<DashboardEnv>();
  app.get(
    "/login",
    (c) =>
      html(c, <LoginPage returnTo={returnPath(c.req.query("returnTo"))} />),
  );
  app.post("/login", async (c) => {
    const input = await c.req.parseBody();
    try {
      const parsed = z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(256),
      }).parse(input);
      const session = await admin.owner.login(parsed.username, parsed.password);
      ownerCookie(c, session.token);
      await admin.audit.write("owner.login", "owner", session.username);
      return c.redirect(returnPath(String(input.returnTo ?? "/")), 303);
    } catch (error) {
      return html(
        c,
        <LoginPage
          error={error instanceof AdminError
            ? error.message
            : "Enter your username and password."}
          returnTo={returnPath(String(input.returnTo ?? "/"))}
        />,
        error instanceof AdminError ? error.status : 400,
      );
    }
  });
  for (
    const filename of [
      "dashboard.css",
      "app.js",
      "api.js",
      "actions.js",
      "dialogs.js",
    ]
  ) {
    app.get("/assets/" + filename, async () => {
      try {
        return new Response(
          await Deno.readFile(
            new URL("../../../public/assets/" + filename, import.meta.url),
          ),
          {
            headers: {
              "content-type": filename.endsWith(".css")
                ? "text/css; charset=utf-8"
                : "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
              "x-content-type-options": "nosniff",
            },
          },
        );
      } catch {
        return new Response("Asset not found. Run deno task build:dashboard.", {
          status: 404,
        });
      }
    });
  }
  const guard = requireOwner(admin.owner);
  const render = async (
    c: Context<DashboardEnv>,
    title: string,
    content: Child,
  ) => {
    const owner = c.get("owner"),
      record = await admin.owner.owner(),
      settings = await readSettings(admin.store.kv);
    return html(
      c,
      <AppLayout
        title={title}
        path={c.req.path}
        csrf={owner.csrf}
        boardName={settings.boardName}
        defaultPassword={record.defaultPassword}
      >
        {content}
      </AppLayout>,
    );
  };
  app.get(
    "/",
    guard,
    async (c) =>
      render(
        c,
        "Overview",
        <OverviewPage
          data={await admin.observe.overview()}
          activity={await admin.audit.list({ limit: 6 })}
        />,
      ),
  );
  app.get("/dashboard", guard, (c) => c.redirect("/", 303));
  app.get("/conversations", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Conversations",
      <ConversationsPage
        data={await admin.conversations.list(query(url))}
        url={url}
      />,
    );
  });
  app.get("/conversations/:id", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Conversations",
      <ConversationPage
        data={await admin.conversations.detail(c.req.param("id"), query(url))}
        url={url}
      />,
    );
  });
  app.get("/categories", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Categories",
      <CategoriesPage
        data={await admin.categories.list(query(url))}
        url={url}
      />,
    );
  });
  app.get("/agents", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Agents",
      <AgentsPage data={await admin.agents.list(query(url))} url={url} />,
    );
  });
  app.get("/agents/:id", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Agents",
      <AgentPage
        data={await admin.agents.detail(c.req.param("id"), query(url))}
        url={url}
      />,
    );
  });
  app.get("/sessions", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Sessions",
      <SessionsPage
        data={await admin.observe.sessions(query(url))}
        url={url}
      />,
    );
  });
  app.get("/access", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Access credentials",
      url.searchParams.get("view") === "gateways"
        ? (
          <GatewayAccessPage
            data={await records<AccessTokenRecord>(admin.store.kv, [
              "access-token",
            ], query(url))}
            url={url}
          />
        )
        : (
          <IntegrationsPage
            data={await admin.integrations.list(query(url))}
            url={url}
          />
        ),
    );
  });
  app.get("/activity", guard, async (c) => {
    const url = new URL(c.req.url);
    return render(
      c,
      "Activity",
      <ActivityPage data={await admin.audit.list(query(url))} url={url} />,
    );
  });
  app.get(
    "/logs",
    guard,
    (c) =>
      render(
        c,
        "Diagnostics",
        <LogsPage
          items={admin.observe.logs(c.req.query("level"))}
          level={c.req.query("level") ?? ""}
        />,
      ),
  );
  app.get(
    "/settings",
    guard,
    async (c) =>
      render(
        c,
        "Settings",
        <SettingsPage
          settings={await readSettings(admin.store.kv)}
          defaultPassword={(await admin.owner.owner()).defaultPassword}
        />,
      ),
  );
  app.onError(async (error, c) => {
    const status = error instanceof AdminError ? error.status : 400;
    return html(
      c,
      <AppLayout
        title="Request unavailable"
        path={c.req.path}
        csrf={c.get("owner")?.csrf ?? ""}
        boardName={(await readSettings(admin.store.kv)).boardName}
        defaultPassword={false}
      >
        <PageHeader
          title="Request unavailable"
          description={error instanceof AdminError
            ? error.message
            : "Check the address or filters and try again."}
        />
        <Empty
          title="We couldn't load this view"
          detail="Return to the previous page or choose another view from the sidebar."
        />
      </AppLayout>,
      status,
    );
  });
  return app;
}
