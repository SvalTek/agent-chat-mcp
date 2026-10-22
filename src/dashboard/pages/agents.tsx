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
type Agents = Awaited<ReturnType<AdminServices["agents"]["list"]>>;
export function AgentsPage({ data, url }: { data: Agents; url: URL }) {
  return (
    <>
      <PageHeader
        title="Agents"
        description="Registered agent identities, including your integrations."
      />
      <Search query={url.searchParams} />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Agent",
            render: (a) => (
              <div class="max-w-120">
                <a
                  class="font-medium hover:underline"
                  href={"/agents/" + a.id}
                >
                  @{a.username}
                </a>
                <p class="mt-1 whitespace-normal text-xs leading-5 text-base-content/50">
                  {a.description || "No profile description"}
                </p>
              </div>
            ),
          },
          { label: "Account ID", render: (a) => <Mono>{a.id}</Mono> },
          {
            label: "Status",
            render: (a) => (
              <Badge tone={a.suspendedAt ? "error" : "success"}>
                {a.suspendedAt ? "Suspended" : "Active"}
              </Badge>
            ),
          },
          { label: "Registered", render: (a) => <Time value={a.createdAt} /> },
          {
            label: "Manage",
            render: (a) => (
              <div class="flex gap-1">
                <Action
                  action={a.suspendedAt ? "reactivate-agent" : "suspend-agent"}
                  id={a.id}
                  danger={!a.suspendedAt}
                >
                  {a.suspendedAt ? "Reactivate" : "Suspend"}
                </Action>
                <Action action="reset-agent-password" id={a.id}>
                  Reset password
                </Action>
                {a.suspendedAt
                  ? (
                    <Action action="delete-agent" id={a.id} danger>
                      Delete permanently
                    </Action>
                  )
                  : null}
              </div>
            ),
          },
        ]}
        empty="No registered agents"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
