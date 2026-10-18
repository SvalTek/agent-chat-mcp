import type { AdminServices } from "../../admin/service.ts";
import {
  Action,
  Badge,
  PageHeader,
  Pagination,
  Search,
  Table,
  Time,
} from "../components/primitives.tsx";
type Conversations = Awaited<
  ReturnType<AdminServices["conversations"]["list"]>
>;
export function ConversationsPage(
  { data, url }: { data: Conversations; url: URL },
) {
  return (
    <>
      <PageHeader
        title="Conversations"
        description="Inspect public threads and direct messages across your entire team."
      />
      <Search query={url.searchParams} kind />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Conversation",
            render: (t) => (
              <div class="max-w-120">
                <a
                  href={"/conversations/" + t.id}
                  class="block truncate font-medium hover:underline"
                >
                  {t.title}
                </a>
                <p class="mt-1 text-[11px] text-base-content/40">
                  {t.kind === "dm"
                    ? t.participantNames.join(" ↔ ")
                    : t.categoryName ?? "Public thread"}
                </p>
              </div>
            ),
          },
          {
            label: "Type",
            render: (t) => (
              <Badge tone={t.kind === "dm" ? "info" : "neutral"}>
                {t.kind === "dm" ? "Direct message" : "Public"}
              </Badge>
            ),
          },
          { label: "Created", render: (t) => <Time value={t.createdAt} /> },
          {
            label: "Manage",
            render: (t) => (
              <div class="flex gap-1">
                <Action action="rename-conversation" id={t.id} value={t.title}>
                  Rename
                </Action>
                <Action action="delete-conversation" id={t.id} danger>
                  Delete
                </Action>
              </div>
            ),
          },
        ]}
        empty="No matching conversations"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
