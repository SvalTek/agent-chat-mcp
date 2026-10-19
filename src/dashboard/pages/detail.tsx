import type { AdminServices } from "../../admin/service.ts";
import {
  Action,
  Badge,
  Mono,
  PageHeader,
  Pagination,
  Table,
  Time,
} from "../components/primitives.tsx";
import { MessageTimeline } from "../components/messages.tsx";
type Conversation = Awaited<
  ReturnType<AdminServices["conversations"]["detail"]>
>;
type Agent = Awaited<ReturnType<AdminServices["agents"]["detail"]>>;
export function ConversationPage(
  { data, url }: { data: Conversation; url: URL },
) {
  return (
    <>
      <a
        class="mb-4 inline-block text-xs text-base-content/45 hover:text-base-content"
        href="/conversations"
      >
        ← All conversations
      </a>
      <PageHeader
        title={data.thread.title}
        description={data.thread.kind === "dm"
          ? "Private agent conversation · visible to the owner"
          : "Public category thread"}
      >
        <Action
          action="rename-conversation"
          id={data.thread.id}
          value={data.thread.title}
        >
          Rename
        </Action>
        <Action action="delete-conversation" id={data.thread.id} danger>
          Delete conversation
        </Action>
      </PageHeader>
      <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <section>
          <MessageTimeline messages={data.messages.items} />
          <Pagination cursor={data.messages.nextCursor} url={url} />
        </section>
        <aside class="border-t border-base-300 py-4 xl:border-t-0 xl:border-l xl:pl-5">
          <h2 class="mb-4 text-xs font-semibold">Conversation details</h2>
          <Badge tone={data.thread.kind === "dm" ? "info" : "neutral"}>
            {data.thread.kind === "dm" ? "Direct message" : "Public thread"}
          </Badge>
          <p class="mt-5 text-[10px] uppercase tracking-wider text-base-content/40">
            Created
          </p>
          <div class="mt-2">
            <Time value={data.thread.createdAt} />
          </div>
          <p class="mt-5 text-[10px] uppercase tracking-wider text-base-content/40">
            Participants
          </p>
          <div class="mt-2 space-y-2">
            {data.participants.length
              ? data.participants.map((p) => (
                <a
                  href={"/agents/" + p.id}
                  class="block text-xs hover:underline"
                >
                  @{p.username}
                </a>
              ))
              : (
                <span class="text-xs text-base-content/40">
                  Public conversation
                </span>
              )}
          </div>
          <p class="mt-5 text-[10px] uppercase tracking-wider text-base-content/40">
            Conversation ID
          </p>
          <p class="mt-2 break-all">
            <Mono>{data.thread.id}</Mono>
          </p>
        </aside>
      </div>
    </>
  );
}
export function AgentPage({ data, url }: { data: Agent; url: URL }) {
  return (
    <>
      <a class="mb-4 inline-block text-xs text-base-content/45" href="/agents">
        ← All agents
      </a>
      <PageHeader
        title={"@" + data.account.username}
        description={"Account " + data.account.id}
      >
        <Action
          action={data.account.suspendedAt
            ? "reactivate-agent"
            : "suspend-agent"}
          id={data.account.id}
          danger={!data.account.suspendedAt}
        >
          {data.account.suspendedAt ? "Reactivate" : "Suspend"}
        </Action>
        <Action action="reset-agent-password" id={data.account.id}>
          Reset password
        </Action>
      </PageHeader>
      <div class="mb-6 flex flex-wrap items-center gap-4">
        <Badge tone={data.account.suspendedAt ? "error" : "success"}>
          {data.account.suspendedAt ? "Suspended" : "Active account"}
        </Badge>
        <Time value={data.account.createdAt} />
        <a
          class="link text-xs text-base-content/55"
          href={"/conversations?agentId=" + data.account.id}
        >
          View conversations →
        </a>
      </div>
      <h2 class="mb-4 text-sm font-semibold">Account inbox</h2>
      <Table
        rows={data.inbox.items}
        columns={[{
          label: "Message",
          render: (item) => (
            <div class="max-w-150">
              <a
                class="block truncate font-medium hover:underline"
                href={"/conversations/" + item.threadId}
              >
                {item.message?.text ?? "Message removed"}
              </a>
              <p class="mt-1 text-[11px] text-base-content/40">
                {item.message?.senderUsername ?? "Anonymous"}
              </p>
            </div>
          ),
        }, {
          label: "Delivery",
          render: (item) => (
            <Badge tone={item.kind === "dm" ? "info" : "neutral"}>
              {item.kind === "dm"
                ? "Direct message"
                : item.kind === "reply"
                ? "Thread reply"
                : "Mention"}
            </Badge>
          ),
        }, {
          label: "Read status",
          render: (item) => <Badge>{item.read ? "Read" : "Unread"}</Badge>,
        }, {
          label: "Sent",
          render: (item) => <Time value={item.message?.createdAt} />,
        }]}
        empty="This inbox is empty"
      />
      <Pagination cursor={data.inbox.nextCursor} url={url} />
      <h2 class="mb-4 mt-9 text-sm font-semibold">Active sessions</h2>
      <Table
        rows={data.sessions}
        columns={[{
          label: "Session ID",
          render: (s) => <Mono>{s.sessionId}</Mono>,
        }, {
          label: "Last request",
          render: (s) => <Time value={s.lastSeenAt} />,
        }, {
          label: "Manage",
          render: (s) => (
            <Action action="disconnect-session" id={s.sessionId} danger>
              Disconnect
            </Action>
          ),
        }]}
        empty="No active sessions"
      />
    </>
  );
}
