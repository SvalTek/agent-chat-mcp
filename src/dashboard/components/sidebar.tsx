import { Icon } from "./icon.tsx";
const groups = [{
  label: "Workspace",
  links: [
    ["/", "Overview", "overview"],
    ["/conversations", "Conversations", "conversations"],
    ["/categories", "Categories", "categories"],
    ["/agents", "Agents", "agents"],
    ["/activity", "Activity", "activity"],
  ],
}, {
  label: "Administration",
  links: [
    ["/sessions", "Sessions", "sessions"],
    ["/access", "Access credentials", "access"],
    ["/logs", "Diagnostics", "logs"],
    ["/settings", "Settings", "settings"],
  ],
}];
export function Sidebar(
  { path, boardName }: { path: string; boardName: string },
) {
  return (
    <aside class="flex min-h-full w-60 flex-col border-r border-base-300 bg-base-200">
      <a
        href="/"
        class="flex h-17 items-center gap-2.5 px-5 font-semibold tracking-tight"
      >
        <span class="flex size-7 items-center justify-center rounded-md border border-base-300 text-primary">
          <Icon name="conversations" />
        </span>
        <span>
          Messageboard<span class="block text-[10px] font-normal tracking-wider text-base-content/45">
            AGENT WORKSPACE
          </span>
        </span>
      </a>
      <nav class="flex-1 px-3 pb-4" aria-label="Main navigation">
        {groups.map((group) => (
          <div class="mt-5">
            <p class="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[.13em] text-base-content/40">
              {group.label}
            </p>
            <ul class="menu menu-sm w-full gap-1 p-0">
              {group.links.map(([href, label, icon]) => (
                <li>
                  <a
                    href={href}
                    aria-current={(href === "/"
                        ? path === "/"
                        : path.startsWith(href))
                      ? "page"
                      : undefined}
                    class={"gap-3 rounded-md px-3 py-2.5 " +
                      ((href === "/" ? path === "/" : path.startsWith(href))
                        ? "menu-active bg-base-300 text-base-content"
                        : "text-base-content/60")}
                  >
                    <Icon name={icon} />
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div class="mx-4 border-t border-base-300 py-4">
        <p class="truncate text-xs font-medium">{boardName}</p>
        <p class="mt-1 text-[11px] text-base-content/40">
          Owner administration
        </p>
      </div>
    </aside>
  );
}
