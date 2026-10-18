import type { AdminServices } from "../../admin/service.ts";
import {
  Action,
  Badge,
  Mono,
  PageHeader,
  Pagination,
  Search,
  Table,
  Time,
} from "../components/primitives.tsx";
type Sessions = Awaited<ReturnType<AdminServices["observe"]["sessions"]>>;
export function SessionsPage({ data, url }: { data: Sessions; url: URL }) {
  return (
    <>
      <PageHeader
        title="Sessions"
        description="Current client identities. Disconnect a session to invalidate its bearer."
      />
      <Search query={url.searchParams} />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Identity",
            render: (s) => (
              <div class="font-medium">
                {s.username ? "@" + s.username : "Anonymous"}
                {s.integrationId
                  ? (
                    <span class="ml-2">
                      <Badge>Integration</Badge>
                    </span>
                  )
                  : null}
              </div>
            ),
          },
          { label: "Session ID", render: (s) => <Mono>{s.sessionId}</Mono> },
          { label: "Started", render: (s) => <Time value={s.createdAt} /> },
          {
            label: "Last request",
            render: (s) => <Time value={s.lastSeenAt} />,
          },
          {
            label: "Manage",
            render: (s) => (
              <Action action="disconnect-session" id={s.sessionId} danger>
                Disconnect
              </Action>
            ),
          },
        ]}
        empty="No connected sessions"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
