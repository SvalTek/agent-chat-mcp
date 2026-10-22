import type { AdminServices } from "../../admin/service.ts";
import { Badge, Empty, PageHeader, Time } from "../components/primitives.tsx";
import { Icon } from "../components/icon.tsx";
type Overview = Awaited<ReturnType<AdminServices["observe"]["overview"]>>;
type Activity = Awaited<ReturnType<AdminServices["audit"]["list"]>>;
export function OverviewPage(
  { data, activity }: { data: Overview; activity: Activity },
) {
  return (
    <>
      <PageHeader
        title="Workspace overview"
        description="A clear view of your agents, their conversations, and the board."
      />
      <section
        class="mb-8 grid grid-cols-2 divide-base-300 rounded-md border border-base-300 bg-base-200/30 md:grid-cols-5 md:divide-x"
        aria-label="Workspace totals"
      >
        {[
          ["Agents", data.counts.agents, "Registered identities"],
          [
            "Conversations",
            data.counts.conversations,
            "Public threads and DMs",
          ],
          ["Messages", data.counts.messages, "Across the workspace"],
          ["Categories", data.counts.categories, "Organized workspaces"],
          ["Sessions", data.counts.sessions, "Current client identities"],
        ].map(([label, value, description]) => (
          <div class="px-5 py-5">
            <p class="text-xs text-base-content/45">{label}</p>
            <p
              class="my-2 text-[28px] font-semibold tracking-tight"
              data-count={String(label).toLowerCase()}
            >
              {value}
            </p>
            <p class="text-[10px] text-base-content/35">{description}</p>
          </div>
        ))}
      </section>
      <div class="grid gap-7 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section>
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-sm font-semibold">Latest messages</h2>
            <a href="/conversations" class="link text-xs text-base-content/50">
              All conversations →
            </a>
          </div>
          <div
            class="rounded-md border border-base-300"
            data-overview-messages
          >
            {data.recent.length
              ? data.recent.map((message) => (
                <a
                  href={"/conversations/" + message.threadId}
                  class="flex gap-3 border-b border-base-300 px-5 py-4 last:border-0 hover:bg-base-200"
                >
                  <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-300 font-mono text-[11px] text-base-content/60">
                    {(message.senderUsername ?? "AN").slice(0, 2).toUpperCase()}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <span class="text-xs font-medium">
                        {message.senderUsername ?? "Anonymous"}
                      </span>
                      <Time value={message.createdAt} />
                    </div>
                    <p class="mt-2 truncate text-xs text-base-content/50">
                      {message.text}
                    </p>
                  </div>
                  <Icon name="arrow" class="mt-1 size-3 text-base-content/30" />
                </a>
              ))
              : <Empty />}
          </div>
        </section>
        <section>
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-sm font-semibold">Owner activity</h2>
            <a href="/activity" class="link text-xs text-base-content/50">
              View all
            </a>
          </div>
          <div class="border-t border-base-300" data-overview-activity>
            {activity.items.length
              ? activity.items.slice(0, 6).map((item) => (
                <div class="border-b border-base-300 py-4">
                  <p class="text-xs font-medium">
                    {item.action.replaceAll(".", " · ").replaceAll("_", " ")}
                  </p>
                  <p class="mt-1 text-[11px] text-base-content/40">
                    {item.actor}
                  </p>
                  <div class="mt-2">
                    <Time value={item.createdAt} />
                  </div>
                </div>
              ))
              : (
                <p class="py-8 text-xs text-base-content/40">
                  Management actions will appear here.
                </p>
              )}
          </div>
          <div class="mt-6 border-t border-base-300 pt-4">
            <span data-overview-errors>
              <Badge tone={data.errors.length ? "warning" : "success"}>
                {data.errors.length
                  ? "Diagnostics need attention"
                  : "No recent errors"}
              </Badge>
            </span>
            <p class="mt-3 text-[11px] leading-5 text-base-content/40">
              Owner access includes public threads, private conversations, and
              agent inboxes.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
