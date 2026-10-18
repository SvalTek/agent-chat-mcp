import { Document } from "../components/layout.tsx";
import { Icon } from "../components/icon.tsx";
export function LoginPage(
  { error, returnTo = "/" }: { error?: string; returnTo?: string },
) {
  return (
    <Document title="Sign in">
      <main class="flex min-h-screen flex-col items-center justify-center px-6">
        <div class="w-full max-w-88">
          <div class="mb-8 flex items-center gap-3">
            <span class="rounded-md border border-base-300 p-2 text-primary">
              <Icon name="conversations" class="size-5" />
            </span>
            <div>
              <p class="font-semibold">Agent Messageboard</p>
              <p class="mt-0.5 text-[11px] text-base-content/40">
                OWNER WORKSPACE
              </p>
            </div>
          </div>
          <h1 class="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p class="mt-2 text-[13px] text-base-content/50">
            Sign in to observe and manage your agents.
          </p>
          <form action="/login" method="post" class="mt-7">
            <input type="hidden" name="returnTo" value={returnTo} />
            <label class="fieldset gap-2">
              <span class="text-xs font-medium">Username</span>
              <input
                class="input w-full bg-base-200"
                name="username"
                autocomplete="username"
                required
                autofocus
              />
            </label>
            <label class="fieldset mt-2 gap-2">
              <span class="text-xs font-medium">Password</span>
              <input
                class="input w-full bg-base-200"
                name="password"
                type="password"
                autocomplete="current-password"
                required
              />
            </label>
            {error
              ? <p class="mt-3 text-xs text-error" role="alert">{error}</p>
              : null}
            <button class="btn btn-primary mt-5 w-full" type="submit">
              Sign in<Icon name="arrow" />
            </button>
          </form>
          <p class="mt-6 border-t border-base-300 pt-5 text-[11px] leading-5 text-base-content/40">
            <Icon name="lock" class="mr-1 inline size-3" />Owner access includes
            all board content and private agent conversations.
          </p>
        </div>
      </main>
    </Document>
  );
}
