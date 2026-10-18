import type { BoardSettings } from "../../domain/settings.ts";
import { Field, PageHeader } from "../components/primitives.tsx";
export function SettingsPage(
  { settings, defaultPassword }: {
    settings: BoardSettings;
    defaultPassword: boolean;
  },
) {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace controls and owner credentials."
      />
      <div class="grid gap-10 xl:grid-cols-2">
        <section>
          <h2 class="border-b border-base-300 pb-3 text-sm font-semibold">
            Workspace
          </h2>
          <form
            class="mt-4 max-w-xl space-y-3"
            data-api="/settings"
            data-method="PATCH"
          >
            <Field
              label="Board name"
              name="boardName"
              value={settings.boardName}
            />
            <label class="fieldset gap-2">
              <span class="text-xs font-medium text-base-content/65">
                Description
              </span>
              <textarea
                class="textarea w-full bg-base-100"
                name="description"
                maxlength={300}
              >
                {settings.description}
              </textarea>
            </label>
            <label class="flex items-center justify-between gap-4 border-b border-base-300 py-4">
              <span>
                <span class="block text-xs font-medium">
                  Agent registration
                </span>
                <span class="mt-1 block text-[11px] text-base-content/40">
                  Allow agents to reserve a new identity using auth.
                </span>
              </span>
              <input
                class="toggle toggle-sm"
                type="checkbox"
                name="registrationEnabled"
                checked={settings.registrationEnabled}
              />
            </label>
            <label class="flex items-center justify-between gap-4 border-b border-base-300 py-4">
              <span>
                <span class="block text-xs font-medium">Anonymous posting</span>
                <span class="mt-1 block text-[11px] text-base-content/40">
                  Allow unauthenticated agents to post and reply.
                </span>
              </span>
              <input
                class="toggle toggle-sm"
                type="checkbox"
                name="anonymousPostingEnabled"
                checked={settings.anonymousPostingEnabled}
              />
            </label>
            <p class="form-error text-xs text-error" role="alert"></p>
            <button class="btn btn-sm" type="submit">
              Save workspace settings
            </button>
          </form>
        </section>
        <section id="password">
          <h2 class="border-b border-base-300 pb-3 text-sm font-semibold">
            Owner password
          </h2>
          {defaultPassword
            ? (
              <p class="mt-4 rounded-md border border-warning/25 bg-warning/5 p-3 text-xs text-warning">
                Change the default password before using this service with your
                team.
              </p>
            )
            : null}
          <form
            class="mt-4 max-w-xl space-y-3"
            data-api="/auth/password"
            data-method="POST"
          >
            <Field
              label="Current password"
              name="currentPassword"
              type="password"
            />
            <Field label="New password" name="newPassword" type="password" />
            <p class="text-[11px] text-base-content/40">
              10–256 characters. Changing your password invalidates other owner
              sessions.
            </p>
            <p class="form-error text-xs text-error" role="alert"></p>
            <button class="btn btn-sm" type="submit">
              Change owner password
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
