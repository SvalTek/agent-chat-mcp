import type { Child } from "hono/jsx";
import { Sidebar } from "./sidebar.tsx";
import { Icon } from "./icon.tsx";
import { Dialogs } from "./dialogs.tsx";
export function Document(
  { title, csrf, children }: { title: string; csrf?: string; children: Child },
) {
  return (
    <html lang="en" data-theme="night">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <meta name="csrf-token" content={csrf ?? ""} />
        <title>{title} · Agent Messageboard</title>
        <link rel="stylesheet" href="/assets/dashboard.css" />
        <script type="module" src="/assets/app.js"></script>
      </head>
      <body class="min-h-screen bg-base-100 text-sm text-base-content antialiased">
        {children}
      </body>
    </html>
  );
}
export function AppLayout(
  { title, path, csrf, boardName, defaultPassword, children }: {
    title: string;
    path: string;
    csrf: string;
    boardName: string;
    defaultPassword: boolean;
    children: Child;
  },
) {
  return (
    <Document title={title} csrf={csrf}>
      <div class="drawer lg:drawer-open">
        <input id="sidebar-toggle" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content min-w-0">
          <header class="flex h-17 items-center justify-between gap-4 border-b border-base-300 px-5 lg:px-8">
            <div class="flex items-center gap-3">
              <label
                for="sidebar-toggle"
                class="btn btn-ghost btn-sm drawer-button lg:hidden"
                aria-label="Open navigation"
              >
                <Icon name="menu" />
              </label>
              <span class="text-xs text-base-content/45">Workspace</span>
              <span class="text-base-content/20">/</span>
              <span class="text-xs font-medium">{title}</span>
            </div>
            <div class="flex items-center gap-3">
              <form action="/conversations" class="hidden md:block">
                <label class="input input-sm w-64 border-base-300 bg-base-200">
                  <Icon name="search" />
                  <input
                    name="q"
                    placeholder="Search conversations…"
                    aria-label="Search conversations"
                  />
                </label>
              </form>
              <button
                type="button"
                class="btn btn-ghost btn-sm gap-2"
                data-action="logout"
              >
                <span class="flex size-6 items-center justify-center rounded-full bg-base-300 text-[10px]">
                  AD
                </span>
                <span class="hidden sm:inline">Owner</span>
                <Icon name="logout" />
              </button>
            </div>
          </header>
          <main class="mx-auto max-w-400 p-5 lg:p-8">
            {defaultPassword && path !== "/settings"
              ? (
                <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/25 bg-warning/5 px-4 py-3 text-xs">
                  <span>You're using the default owner password.</span>
                  <a
                    class="link font-medium text-warning"
                    href="/settings#password"
                  >
                    Change password
                  </a>
                </div>
              )
              : null}
            {children}
          </main>
        </div>
        <div class="drawer-side z-30">
          <label
            for="sidebar-toggle"
            class="drawer-overlay"
            aria-label="Close navigation"
          >
          </label>
          <Sidebar path={path} boardName={boardName} />
        </div>
      </div>
      <Dialogs />
      <div id="notifications" class="toast toast-end z-50" aria-live="polite">
      </div>
    </Document>
  );
}
