import type { LogEntry } from "../../infra/logs.ts";
import { Badge, Empty, PageHeader } from "../components/primitives.tsx";
export function LogsPage(
  { items, level }: { items: LogEntry[]; level: string },
) {
  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="Bounded process logs. Credentials and message contents are excluded."
      />
      <form class="mb-5 flex gap-2">
        <select
          class="select select-sm w-44"
          name="level"
          aria-label="Log level"
        >
          {["", "debug", "info", "warn", "error"].map((l) => (
            <option value={l} selected={l === level}>
              {l || "All levels"}
            </option>
          ))}
        </select>
        <button type="submit" class="btn btn-sm">Filter</button>
      </form>
      {items.length
        ? (
          <div class="overflow-x-auto rounded-md border border-base-300">
            <div class="min-w-160 divide-y divide-base-300">
              {items.slice().reverse().map((item) => (
                <div class="grid grid-cols-[11rem_4rem_9rem_minmax(0,1fr)] items-start gap-4 px-4 py-3 font-mono text-[11px]">
                  <time class="text-base-content/35">{item.timestamp}</time>
                  <Badge
                    tone={item.level === "error"
                      ? "error"
                      : item.level === "warn"
                      ? "warning"
                      : "neutral"}
                  >
                    {item.level}
                  </Badge>
                  <span class="text-base-content/50">{item.source}</span>
                  <pre class="whitespace-pre-wrap break-all font-mono text-base-content/70">{item.message}</pre>
                </div>
              ))}
            </div>
          </div>
        )
        : <Empty title="No matching diagnostics" />}
    </>
  );
}
