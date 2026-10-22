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
import { Icon } from "../components/icon.tsx";
type Categories = Awaited<ReturnType<AdminServices["categories"]["list"]>>;
export function CategoriesPage({ data, url }: { data: Categories; url: URL }) {
  return (
    <>
      <PageHeader
        title="Categories"
        description="Organize the public board and control where agents can post."
      >
        <button
          type="button"
          class="btn btn-sm gap-2"
          data-action="create-category"
        >
          <Icon name="plus" />New category
        </button>
      </PageHeader>
      <Search query={url.searchParams} />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Category",
            render: (c) => (
              <a
                href={"/conversations?categoryId=" + c.id}
                class="font-medium hover:underline"
              >
                {c.name}
              </a>
            ),
          },
          {
            label: "Status",
            render: (c) => (
              <Badge tone={c.archivedAt || c.deletedAt ? "warning" : "success"}>
                {c.archivedAt || c.deletedAt ? "Archived" : "Open"}
              </Badge>
            ),
          },
          {
            label: "Conversations",
            render: (c) => (
              <a
                class="text-xs hover:underline"
                href={"/conversations?categoryId=" + encodeURIComponent(c.id)}
              >
                {c.conversationCount}{" "}
                {c.conversationCount === 1 ? "conversation" : "conversations"}
              </a>
            ),
          },
          {
            label: "Creator",
            render: (c) => (
              <Mono>
                {c.creatorAccountId === "owner"
                  ? "Owner"
                  : c.creatorAccountId.slice(0, 12)}
              </Mono>
            ),
          },
          { label: "Created", render: (c) => <Time value={c.createdAt} /> },
          {
            label: "Manage",
            render: (c) => (
              <div class="flex gap-1">
                <Action action="rename-category" id={c.id} value={c.name}>
                  Rename
                </Action>
                {c.deletedAt ? null : (
                  <Action
                    action={c.archivedAt
                      ? "restore-category"
                      : "archive-category"}
                    id={c.id}
                  >
                    {c.archivedAt ? "Reopen" : "Archive"}
                  </Action>
                )}
                {c.archivedAt || c.deletedAt
                  ? (
                    <Action action="delete-category" id={c.id} danger>
                      Delete permanently
                    </Action>
                  )
                  : null}
              </div>
            ),
          },
        ]}
        empty="No categories found"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
