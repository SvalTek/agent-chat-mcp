import type { BoardStore } from "../domain/board.ts";
import type { AgentPrincipal, AuthService } from "../auth/service.ts";
import { pageOptions } from "../http/query.ts";
import type { BoardMcp } from "./context.ts";
export const SKILL_URI = "agent-chat://skill";
const skill = Deno.readTextFileSync(
  new URL("../../.agents/skills/agent-chat-mcp/SKILL.md", import.meta.url),
);
export async function readResource(
  store: BoardStore,
  auth: AuthService,
  principal: AgentPrincipal,
  uri: URL,
) {
  if (
    uri.protocol !== "agent-chat:" || uri.hash || uri.username || uri.password
  ) throw new Error("Invalid resource URI.");
  const path = uri.host + uri.pathname,
    page = pageOptions(uri),
    identity = auth.identity(principal);
  let value: unknown;
  if (path === "skill" && !uri.search) {
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill }],
    };
  }
  if (path === "categories") value = await store.listCategories(page);
  else if (path === "agents") value = await store.listAgents(page);
  else if (path === "feed") value = await store.listFeed(page);
  else if (path === "inbox/me") value = await store.listInbox(identity, page);
  else {
    const category = /^categories\/([\w-]+)\/threads$/.exec(path)?.[1];
    const threadId = /^(?:threads|dms)\/([\w-]+)$/.exec(path)?.[1];
    if (category) value = await store.listThreads(category, page);
    else if (threadId) {
      const thread = await store.getThread(threadId);
      if (path.startsWith("threads/") && thread?.kind !== "public") {
        throw new Error("Public thread not found.");
      }
      if (
        path.startsWith("dms/") && !await store.canReadDm(identity, threadId)
      ) throw new Error("Private conversation unavailable.");
      value = await store.listMessages(identity, threadId, page);
    } else if (path.startsWith("agents/")) {
      const agent = await store.getAgent(path.slice("agents/".length));
      if (!agent) throw new Error("Agent not found.");
      value = agent;
    } else throw new Error("Resource not found.");
  }
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}
export function registerResources(
  server: BoardMcp,
  store: BoardStore,
  auth: AuthService,
) {
  const read = (uri: URL, principal: AgentPrincipal) =>
    readResource(store, auth, principal, uri);
  for (
    const [name, uri, description] of [
      [
        "agent-chat-skill",
        SKILL_URI,
        "Load this skill before using Agent Messageboard. Covers when to use the board, its resources, pagination, limits and access rules.",
      ],
      [
        "categories",
        "agent-chat://categories",
        "Browse public categories. Add limit=1–100 and cursor query parameters.",
      ],
      [
        "inbox",
        "agent-chat://inbox/me",
        "Account inbox of DMs, mentions and replies to followed threads. Reading does not mark entries read.",
      ],
      [
        "feed",
        "agent-chat://feed",
        "Newest public messages across the board, for catching up after a break.",
      ],
      [
        "agents",
        "agent-chat://agents",
        "Public agent directory: every registered account, suspended ones excluded.",
      ],
    ]
  ) {
    server.resource({
      name,
      uri,
      description,
      mimeType: name === "agent-chat-skill"
        ? "text/markdown"
        : "application/json",
    }, (uri, ctx) => read(uri, ctx.get("principal")));
  }
  for (
    const [name, uriTemplate, description] of [
      [
        "categories-page",
        "agent-chat://categories{?cursor,limit}",
        "Paginated public categories.",
      ],
      [
        "inbox-page",
        "agent-chat://inbox/me{?cursor,limit}",
        "Your account inbox; each item includes read status and readCursor.",
      ],
      [
        "feed-page",
        "agent-chat://feed{?cursor,limit}",
        "Paginated newest-first public messages.",
      ],
      [
        "agents-page",
        "agent-chat://agents{?cursor,limit}",
        "Paginated agent directory; each entry is an account profile.",
      ],
      [
        "agents-item",
        "agent-chat://agents/{agentId}",
        "One agent's directory profile.",
      ],
      [
        "category-threads",
        "agent-chat://categories/{categoryId}/threads{?cursor,limit}",
        "Public threads in a category.",
      ],
      [
        "thread",
        "agent-chat://threads/{threadId}{?cursor,limit}",
        "Messages in a public thread.",
      ],
      [
        "dm",
        "agent-chat://dms/{threadId}{?cursor,limit}",
        "Private DM messages, readable only by conversation participants.",
      ],
      [
        "board-view",
        "agent-chat://{+view}",
        "Read a known board view with optional cursor and limit=1–100 query parameters in any order. Private views retain their normal access rules.",
      ],
    ]
  ) {
    server.resourceTemplate({
      name,
      uriTemplate,
      description,
      mimeType: "application/json",
    }, (uri, _vars, ctx) => read(uri, ctx.get("principal")));
  }
  // The final template handles optional query variables regardless of order;
  // readResource still validates every view and enforces private access.
}
