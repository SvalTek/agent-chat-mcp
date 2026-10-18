import type { Child } from "hono/jsx";
import { Icon } from "./icon.tsx";
export function PageHeader(
  { title, description, children }: {
    title: string;
    description: string;
    children?: Child;
  },
) {
  return (
    <div class="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-[23px] font-semibold tracking-tight">{title}</h1>
        <p class="mt-1.5 text-[13px] text-base-content/50">{description}</p>
      </div>
      <div class="flex items-center gap-2">
        {children ?? (
          <button type="button" class="btn btn-sm gap-2" data-action="refresh">
            <Icon name="refresh" />Refresh
          </button>
        )}
      </div>
    </div>
  );
}
export function Badge(
  { children, tone = "neutral" }: { children: Child; tone?: string },
) {
  const colors: Record<string, string> = {
    neutral: "badge-ghost",
    success: "badge-success",
    warning: "badge-warning",
    error: "badge-error",
    info: "badge-info",
  };
  return (
    <span
      class={"badge badge-sm badge-soft " + (colors[tone] ?? colors.neutral)}
    >
      {children}
    </span>
  );
}
export function Empty(
  {
    title = "Nothing here yet",
    detail = "Activity will appear here as your agents use the board.",
  }: { title?: string; detail?: string },
) {
  return (
    <div class="py-18 text-center">
      <span class="mb-3 inline-flex rounded-lg border border-base-300 p-3 text-base-content/35">
        <Icon name="conversations" class="size-5" />
      </span>
      <p class="text-sm font-medium">{title}</p>
      <p class="mx-auto mt-2 max-w-md text-xs leading-5 text-base-content/40">
        {detail}
      </p>
    </div>
  );
}
export function Table<T>(
  { columns, rows, empty }: {
    columns: { label: string; render: (row: T) => Child }[];
    rows: T[];
    empty?: string;
  },
) {
  return rows.length
    ? (
      <div class="overflow-x-auto rounded-md border border-base-300">
        <table class="table table-sm">
          <thead class="bg-base-200 text-[11px] text-base-content/45">
            <tr>
              {columns.map((col) => (
                <th class="py-3 font-medium">{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr class="border-base-300 hover:bg-base-200/50">
                {columns.map((col) => (
                  <td key={col.label} class="py-3">{col.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    : (
      <div class="rounded-md border border-base-300">
        <Empty title={empty} />
      </div>
    );
}
export function Action(
  { action, id, value, children, danger = false, extra }: {
    action: string;
    id?: string;
    value?: string;
    children: Child;
    danger?: boolean;
    extra?: string;
  },
) {
  return (
    <button
      type="button"
      class={"btn btn-ghost btn-xs " +
        (danger ? "text-error" : "text-base-content/60")}
      data-action={action}
      data-id={id}
      data-value={value}
      data-extra={extra}
    >
      {children}
    </button>
  );
}
export function Search(
  { query, kind = false }: { query: URLSearchParams; kind?: boolean },
) {
  return (
    <form class="mb-5 flex flex-wrap items-center gap-2">
      <label class="input input-sm w-full border-base-300 bg-base-200 sm:max-w-80">
        <Icon name="search" />
        <input
          name="q"
          value={query.get("q") ?? ""}
          placeholder="Search…"
          aria-label="Filter results"
          maxlength={200}
        />
      </label>
      {kind
        ? (
          <select
            name="kind"
            class="select select-sm w-36 bg-base-200"
            aria-label="Conversation type"
          >
            <option value="">All conversations</option>
            <option value="public" selected={query.get("kind") === "public"}>
              Public threads
            </option>
            <option value="dm" selected={query.get("kind") === "dm"}>
              Direct messages
            </option>
          </select>
        )
        : null}
      <button type="submit" class="btn btn-sm">Apply filters</button>
      {query.size
        ? (
          <a class="btn btn-ghost btn-sm" href={kind ? "/conversations" : "?"}>
            Clear
          </a>
        )
        : null}
    </form>
  );
}
export function Pagination(
  { cursor, url }: { cursor: string | null; url: URL },
) {
  const next = new URL(url);
  if (cursor) next.searchParams.set("cursor", cursor);
  return (
    <div class="mt-4 flex items-center justify-between text-xs text-base-content/40">
      <span>Cursor pagination · 30 per page</span>
      <div class="join">
        {url.searchParams.has("cursor")
          ? <a class="btn btn-sm join-item" href={url.pathname}>First page</a>
          : null}
        {cursor
          ? (
            <a class="btn btn-sm join-item" href={next.pathname + next.search}>
              Next page →
            </a>
          )
          : <span class="px-2">End of results</span>}
      </div>
    </div>
  );
}
export function Time({ value }: { value?: string | null }) {
  return value
    ? (
      <time
        class="whitespace-nowrap text-xs text-base-content/45"
        datetime={value}
        title={value}
      >
        {new Date(value).toLocaleString("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        })} UTC
      </time>
    )
    : <span class="text-base-content/30">—</span>;
}
export function Mono({ children }: { children: Child }) {
  return (
    <span class="font-mono text-[11px] text-base-content/45">{children}</span>
  );
}
export function Field(
  { label, name, value = "", type = "text", required = true }: {
    label: string;
    name: string;
    value?: string;
    type?: string;
    required?: boolean;
  },
) {
  return (
    <label class="fieldset w-full gap-2 py-2">
      <span class="text-xs font-medium text-base-content/65">{label}</span>
      <input
        class="input input-sm w-full bg-base-100"
        type={type}
        name={name}
        value={value}
        required={required}
      />
    </label>
  );
}
