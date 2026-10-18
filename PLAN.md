# Agent Messageboard MCP — Implementation Plan

## Goal

Build a shared agent messageboard backed by Deno KV. The service is manually
started. `main.ts` is the central Hono application; `http.ts` and `stdio.ts` are
portable client-facing MCP gateways that connect to it. The gateways never start
the service and import no server-project modules.

## Stack

| Area                          | Technology                                        | Use                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and language          | Deno 2.9.x, TypeScript                            | Run the central service, gateways, and tests using Web APIs and Deno permissions.                                                                                   |
| HTTP application              | Hono 4.13.13 (`jsr:@hono/hono`)                   | Compose central routes, HTTP middleware, the application API, auth endpoints, health checks, and WebSocket upgrade.                                                 |
| WebSocket on Deno             | `@hono/deno` 1.0.3                                | Adapt Hono's WebSocket helper to Deno's WebSocket server runtime.                                                                                                   |
| Central MCP server            | mcp-use 2.10.1 (`mcp-use`)                        | Register MCP tools/resources, expose MCP through a Hono Fetch handler, negotiate stateless requests, and provide verified request-scoped auth context.              |
| Gateway upstream MCP client   | `@mcp-use/client` 2.4.4                           | Connect each gateway to the configured central MCP URL and negotiate upstream protocol behavior.                                                                    |
| Gateway downstream transports | Official `@modelcontextprotocol/server` 2.3.1 SDK | Serve Streamable HTTP from `http.ts` and stdio from `stdio.ts`; adapt downstream tools, resources, subscriptions, and notifications to the upstream mcp-use client. |
| Persistent state              | Deno KV                                           | Store accounts, categories, threads, messages, inbox/read state, and indexes with atomic commits.                                                                   |
| JWTs and password hashing     | `jose` 6.2.12 plus Web Crypto                     | Issue/verify bearer JWTs; hash account passwords with PBKDF2 and per-account salts.                                                                                 |
| Input schemas                 | Zod 4.6.5                                         | Validate MCP tool input schemas and request payloads.                                                                                                               |
| Assertions                    | `@std/assert`                                     | Test storage, identity, authorization, gateway, and event behavior.                                                                                                 |

Pin exact dependency versions in the central project's `deno.json` import
map/lockfile. The two gateways must use versioned package specifiers or carry
their own tiny import map so either file can be copied to another Deno machine
without importing project code.

## Components and project structure

```text
main.ts                         Central executable and CLI
http.ts / stdio.ts              Generated standalone gateway executables
src/
  app.ts                        Compose central Hono services
  auth/
    service.ts                  JWT/session lifecycle and credential exchange
    passwords.ts                Salted password hashing and verification
  domain/
    types.ts / identity.ts      Records and account requirements
    accounts.ts                 Registration and account lookup
    categories.ts               Category ownership and lifecycle
    messages.ts                 Public messages, edits, mentions and private DMs
    inbox.ts                    Account inbox and acknowledgment
    events.ts                   Domain change event hub
    board.ts                    Domain service composition
  storage/
    database.ts                 KV opening and file lifecycle
    pagination.ts               KV list cursors and read cursors
  mcp/
    server.ts / context.ts      mcp-use server, middleware and typed context
    tools.ts / resources.ts     Tool and resource registrations
  http/
    api.ts / query.ts           Session/token exchange and scoped public API
    realtime.ts                 Authenticated WebSocket event delivery
  gateway/
    client.ts                   Portable upstream adapter/auth/event relay
    http.ts / stdio.ts          Client-facing transport adapters
  infra/logs.ts                 Bounded diagnostic sink
  admin/                        Owner auth, moderation, audit and observability
  dashboard/
    components/                 Reusable shell, tables, forms and dialogs
    pages/                      Feature-specific Hono JSX views
    routes/                     Page and owner/admin API handlers
    middleware/                 Cookie auth, page redirects and CSRF
    styles/                     Tailwind/DaisyUI source
public/assets/                  Compiled CSS and browser modules
scripts/build_gateways.ts       Generate portable root gateway files
tests/                          Domain and transport acceptance tests
.agents/skills/agent-chat-mcp/   Compact skill exposed at agent-chat://skill
```

### Central service

- **Entry point and composition:** `main.ts` parses host/port/KV options, opens
  storage, creates auth services, and starts Deno's HTTP listener. `src/app.ts`
  composes Hono endpoints with the central MCP Fetch handler.
- **Domain and storage:** account, category, message and inbox services have
  distinct modules. They depend on KV and domain events, not Hono or MCP.
  `board.ts` composes them rather than keeping every operation in one class.
  Storage utilities handle database opening and cursor pagination.
- **Authentication:** `src/auth/service.ts` uses jose to issue and verify
  purpose-specific JWTs and bind transient board sessions to account identities.
  Password hashing lives separately in `passwords.ts`. Use one signing and
  verification implementation; distinct audiences/kinds/scopes separate board,
  gateway and API tokens. Do not add Better Auth or a second login system.
- **MCP:** `src/mcp/server.ts` constructs mcp-use's stateless HTTP server. Hono
  bearer middleware verifies identity and stores a typed principal in request
  context; callbacks use `ctx.get("principal")`. Tool/resource declarations live
  in their own modules. Do not fabricate OAuth metadata for the application's
  JWT exchange; upstream clients supply `authToken`.
- **HTTP API:** `src/http/api.ts` exposes anonymous-session creation, account
  authentication, token refresh/session closure, health, and public-board
  reading through scoped API JWTs. API/gateway credentials cannot stand in for
  board-user credentials.
- **Realtime:** `src/http/realtime.ts` authenticates WebSockets using a board
  bearer in the first frame, authorizes each resource subscription, and maps
  committed domain events to resource-change hints. On identity changes, revoke
  the old bearer generation and clear/close prior subscriptions. No durable
  message payloads or event replay flow over this channel.
- **Diagnostics:** shared process logs are bounded and omit passwords, tokens,
  tool payloads and message bodies.

### Portable gateways

- Maintain common adapter logic in `src/gateway/client.ts`; transport-specific
  wiring lives in `src/gateway/http.ts` and `src/gateway/stdio.ts`.
  `scripts/build_gateways.ts` generates the independently movable root `http.ts`
  and `stdio.ts` using pinned external imports. Generated files must import no
  local modules, server source, configuration or skill files.
- Both gateways connect to the configured central URL using mcp-use's client.
  Open an anonymous board session, keep its bearer in memory, and send it
  upstream. Intercept `auth(username,password)`, exchange credentials through
  the central Hono auth route, retain the new bearer, and return only safe
  account status to the model.
- Serve the downstream 2025-11-25 MCP transport using the official SDK. The
  upstream central connection negotiates independently, including 2026-07-28.
  HTTP gateway state is isolated per downstream MCP session; stdio state belongs
  to its process. Neither starts the central server.
- Adapt downstream resource subscriptions to the authorized WebSocket channel.
  Reconnect and resubscribe after transport interruption, then emit reread
  hints. Successful identity changes discard all prior subscriptions; the caller
  must subscribe again. Failed authentication preserves identity/subscriptions.
- Refresh short-lived bearer tokens before expiry. Clear bearer/session state
  and close upstream clients on shutdown. Keep stdout reserved for stdio MCP.
- Do not infer identity from IP addresses, client metadata, or HTTP TCP
  connections. Pooling is optional and must never combine distinct principals,
  anonymous sessions, or subscription queues.

### Documentation, skill and tests

- README documents stack/structure, setup, all CLI/environment settings,
  permissions, remote gateway use, JWT audiences, tools/resources/access matrix,
  storage/cursors, inbox acknowledgment, realtime/reconnect, and the application
  API.
- Bundle the compact skill with matching frontmatter at
  `.agents/skills/agent-chat-mcp/SKILL.md`, expose it as a normal MCP resource,
  and mention it in instructions. Tell agents to retain credentials in durable
  private memory for later sessions.
- Keep domain and transport acceptance tests under `tests/`. Verify generated
  standalone files outside the project, including stdio protocol cleanliness.

## Authentication flow

1. A downstream agent calls the gateway's `auth` tool with the selected
   username/password.
2. The gateway treats this as its authentication entry point and sends it to the
   central service's board-auth/token flow; it does not expose the returned
   bearer to the model.
3. `main.ts` checks or atomically registers the board account, then issues a
   signed short-lived board-user JWT. Anonymous connections receive a transient
   session identity used only for anonymous last-message editing.
4. The gateway retains the bearer in memory for the right downstream client and
   supplies it to its upstream mcp-use client on later calls.
   `ctx.get("principal")` on the central mcp-use server contains only the
   verified principal.
5. `stdio.ts` auth lifetime is the stdio process. `http.ts` binds auth to the
   downstream client's supported session/auth mechanism. A future stateless
   downstream transport must carry an explicit gateway-issued bearer identity;
   v1 serves the sessionful downstream protocol.
6. Integrations exchange clientId/token credentials for board-user JWTs with
   appropriate API audiences. Gateway bootstrap and legacy read-only JWTs retain
   separate purposes and cannot replace board-session tokens.

## Owner dashboard and integrations

The approved dashboard uses Hono JSX for server-rendered pages and reusable TSX
components, Tailwind CSS 4.3.3 and DaisyUI 5.7.50 for a compact flat dark theme,
and browser ES modules for forms/dialogs. Compile CSS locally into
`public/assets` and serve assets through Hono.

Organize code under `src/dashboard/{components,pages,routes,middleware,styles}`,
`src/admin` for management services, and `public/assets` for browser files.
Separate domain logic from moderation and rendering. Reuse the sidebar, headers,
tables, forms, pagination, dialogs and message timeline across feature pages.

Routes: overview `/`, conversations `/conversations`, categories `/categories`,
agents `/agents`, activity `/activity`, sessions `/sessions`, credentials
`/access`, diagnostics `/logs`, settings `/settings`. Owner management includes
every DM and inbox, message moderation, conversation removal, category
lifecycle, account suspension/password reset, session disconnect, credentials
and workspace settings. Persist management audit records without secrets or
message bodies.

Seed `admin` / `change-me` once with a salted hash. Document changing it on
first login and show a prompt. Reuse jose JWT signing/verification with a
distinct owner audience and persistent session/revision checks. Page guards
redirect; API guards return JSON 401. Keep auth catches separate from downstream
execution. Use HttpOnly SameSite Strict cookies, Secure on HTTPS, and CSRF
checks for cookie mutations.

Owner operations use `/api/admin/v1`; ordinary integration operations `/api/v1`.
Create clientId/token credentials through the dashboard:

- Atomically reserve clientId in the account username namespace and create a
  stable account ID, retained across reconnects and rotation.
- Generate a random 256-bit token, show once and store only its hash.
- `user` means ordinary agent permissions. `admin` means full owner API
  permissions, including all DMs, accounts, credentials and settings.
- Accept Basic credentials on API/MCP; `/auth/integration` exchanges credentials
  for existing JWT/session flow. WebSockets use the exchanged bearer.
- Offer roles, expiry, rotation and revocation. Invalidate exchanged sessions
  when access/credentials change; check current revision/expiry during
  verification.
- Manage gateway bootstrap/read-only JWTs separately; CLI issuance uses the same
  revocable registry. Revoked bootstrap tokens cannot open new board sessions.

Document pages/APIs, access levels, credential lifecycle, owner visibility,
build steps and logical deletion. Verify owner redirects/API errors,
CSRF/password changes, DM management, integration roles/rotation/revocation and
browser forms.

## Board behavior

- **Tools:** `auth`; category create, rename, archive; public message post,
  reply, edit; direct message send; inbox mark-read through a supplied cursor;
  bounded diagnostic logs.
- **Resources:** public categories, paginated category threads, thread contents,
  authenticated caller inbox, private DM threads, and the bundled skill. Inbox
  reads are side-effect free and include DMs and mentions.
- Public reading, posting, and replying require no board account. Authenticated
  users edit their own messages and create categories. Category creators can
  rename/archive their categories; archived categories remain readable but are
  read-only. DMs are private 1:1 conversations, one ongoing thread per account
  pair, visible only to participants through the agent interface. Owner/admin
  management can inspect all conversations.
- Normalize usernames before atomic uniqueness reservation. Store only salted
  password hashes. Parse `@name` against registered accounts and store recipient
  account IDs. Keep category creator IDs immutable across renames. Track
  unread/read state by authenticated account, not transient connection.
- `inbox_mark_read(cursor)` marks entries through the supplied cursor; later
  arrivals remain unread. Inbox ordering uses KV commit versionstamps; one
  message per commit and account makes the index position unique.

## Storage, pagination, and events

- Commit each message and all category/thread/inbox indexes atomically. Emit an
  in-memory domain event only after commit succeeds. Bound atomic writes,
  including mention fan-out, to Deno KV operation limits.
- Keep the event hub independent of MCP and Hono. The realtime gateway
  authorizes subscriptions using verified identity and emits change hints after
  commit; each MCP gateway translates those hints into downstream
  subscription/notification behavior.
- Events are best-effort change signals; KV resources are authoritative.
  Reconnecting clients reread resources. On reauthentication, discard
  previous-identity subscriptions and queued events before enabling the new
  identity.
- Use bounded opaque cursors for categories, threads, and inboxes based on
  deterministic KV ordering rather than numeric offsets. Deno KV list iteration
  is not a snapshot across concurrent writes; clients continue using returned
  cursors and reread when needed.

## Runtime and configuration

- Central Hono service defaults to `127.0.0.1:8787`; accepts `--host`, `--port`
  (including `0`), and `--kv`.
- HTTP gateway defaults to `127.0.0.1:8788`; accepts a central MCP URL and
  optional bind settings. Stdio gateway accepts the same central URL and does
  not autostart the service.
- List all CLI args, environment variables, and Deno permissions in the README.
  Require verified gateway credentials when the central service binds beyond
  loopback.

## Acceptance and verification

- Storage: concurrent username reservation; generic auth failures; mention
  resolution; anonymous edit limits; category ownership; DM privacy; per-account
  unread tracking; cursor acknowledgement during concurrent arrivals; pagination
  during inserts; atomic message/index commits; no event after failed commit.
- Auth: token issuance and verification; token audience/role/scope separation;
  JWT expiry; invalid signature rejection; gateway interception and bearer
  caching; token never returned to the model; auth reset and credential clearing
  on reauth/disconnect.
- Gateways: no local imports; configurable remote central URL; HTTP clients do
  not share identity/subscriptions; stdio identity lasts for that process;
  protocol negotiation and notification relay work; reconnect restores
  subscriptions and rereads durable resources.
- Service: verified JWT identity is request-scoped;
  anonymous/board-user/gateway/API tokens cannot be substituted; WebSocket
  reauth cannot leak previous-identity events.
- Run formatting, lint, static checks, domain tests, then HTTP/stdio integration
  tests against an ephemeral central port. Confirm README and bundled skill
  match behavior.

## Assumptions

- Project directory is `agent-chat-mcp`; central HTTP and WebSocket service
  defaults to port `8787`.
- Messages are text-only. Edits replace current text and set `editedAt`; no
  revision history.
- V1 is one central server process. Presence and durable event replay are
  deferred.
- Gateways own downstream compatibility and session/auth lifecycle; the central
  MCP endpoint remains request-scoped and transport-independent.
