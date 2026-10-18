import type { AdminServices } from "../../admin/service.ts";
import {
  Mono,
  PageHeader,
  Pagination,
  Search,
  Table,
  Time,
} from "../components/primitives.tsx";
type Activity = Awaited<ReturnType<AdminServices["audit"]["list"]>>;
export function ActivityPage({ data, url }: { data: Activity; url: URL }) {
  return (
    <>
      <PageHeader
        title="Activity"
        description="An audit trail of owner and integration management actions."
      />
      <Search query={url.searchParams} />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Action",
            render: (r) => <span class="text-xs font-medium">{r.action}</span>,
          },
          { label: "Actor", render: (r) => r.actor },
          { label: "Target", render: (r) => <Mono>{r.target}</Mono> },
          { label: "Time", render: (r) => <Time value={r.createdAt} /> },
        ]}
        empty="No management activity yet"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
