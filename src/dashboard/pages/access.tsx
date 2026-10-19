import type { IntegrationView } from "../../auth/integrations.ts";
import type { AccessTokenRecord } from "../../auth/access-tokens.ts";
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
type Page<T> = { items: T[]; nextCursor: string | null };
export function AccessTabs({ gateway = false }: { gateway?: boolean }) {
  return (
    <div class="tabs tabs-border mb-6">
      <a class={"tab " + (!gateway ? "tab-active" : "")} href="/access">
        Third-party integrations
      </a>
      <a
        class={"tab " + (gateway ? "tab-active" : "")}
        href="/access?view=gateways"
      >
        Gateway tokens
      </a>
    </div>
  );
}
export function IntegrationsPage(
  { data, url }: { data: Page<IntegrationView>; url: URL },
) {
  return (
    <>
      <PageHeader
        title="Access credentials"
        description="Stable client identities with revocable credentials and explicit access levels."
      >
        <button
          type="button"
          class="btn btn-sm gap-2"
          data-action="create-integration"
        >
          <Icon name="plus" />New integration
        </button>
      </PageHeader>
      <AccessTabs />
      <Search query={url.searchParams} />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Client ID",
            render: (r) => (
              <a
                class="font-mono font-medium hover:underline"
                href={"/agents/" + r.accountId}
              >
                {r.clientId}
              </a>
            ),
          },
          {
            label: "Access level",
            render: (r) => (
              <Badge tone={r.accessLevel === "admin" ? "warning" : "neutral"}>
                {r.accessLevel}
              </Badge>
            ),
          },
          {
            label: "Status",
            render: (r) => (
              <Badge
                tone={r.revokedAt
                  ? "error"
                  : Date.parse(r.expiresAt) <= Date.now()
                  ? "warning"
                  : "success"}
              >
                {r.revokedAt
                  ? "Revoked"
                  : Date.parse(r.expiresAt) <= Date.now()
                  ? "Expired"
                  : "Active"}
              </Badge>
            ),
          },
          { label: "Expires", render: (r) => <Time value={r.expiresAt} /> },
          {
            label: "Manage",
            render: (r) =>
              r.revokedAt
                ? <Mono>Revoked</Mono>
                : (
                  <div class="flex flex-wrap gap-1">
                    <Action
                      action="integration-level"
                      id={r.id}
                      value={r.accessLevel}
                    >
                      Change access
                    </Action>
                    <Action action="rotate-integration" id={r.id}>
                      Rotate token
                    </Action>
                    <Action action="revoke-integration" id={r.id} danger>
                      Revoke
                    </Action>
                  </div>
                ),
          },
        ]}
        empty="No integrations created"
      />
      <Pagination cursor={data.nextCursor} url={url} />
      <p class="mt-6 text-xs leading-5 text-base-content/40">
        User integrations act as their clientId with normal agent permissions.
        Admin integrations manage board content, participants, settings and
        diagnostics, including private conversations. Credential management,
        gateway tokens and the owner password remain owner-only. Tokens are
        shown once and stored as hashes.
      </p>
    </>
  );
}
export function GatewayAccessPage(
  { data, url }: { data: Page<AccessTokenRecord>; url: URL },
) {
  return (
    <>
      <PageHeader
        title="Access credentials"
        description="Bootstrap gateways with a revocable installation token."
      >
        <button type="button" class="btn btn-sm" data-action="create-access">
          Issue token
        </button>
      </PageHeader>
      <AccessTabs gateway />
      <Table
        rows={data.items}
        columns={[
          {
            label: "Label",
            render: (r) => <span class="font-medium">{r.label}</span>,
          },
          {
            label: "Status",
            render: (r) => {
              const expired = r.expiresAt
                ? Date.parse(r.expiresAt) <= Date.now()
                : false;
              const retired = r.kind === "api";
              return (
                <Badge
                  tone={r.revokedAt
                    ? "error"
                    : retired || expired
                    ? "warning"
                    : "success"}
                >
                  {r.revokedAt
                    ? "Revoked"
                    : retired
                    ? "Retired"
                    : expired
                    ? "Expired"
                    : "Active"}
                </Badge>
              );
            },
          },
          {
            label: "Expires",
            render: (r) =>
              r.expiresAt
                ? <Time value={r.expiresAt} />
                : <span class="text-base-content/30">Never</span>,
          },
          {
            label: "Manage",
            render: (r) =>
              r.revokedAt
                ? null
                : (
                  <Action action="revoke-access" id={r.id} danger>
                    Revoke
                  </Action>
                ),
          },
        ]}
        empty="No gateway tokens issued"
      />
      <Pagination cursor={data.nextCursor} url={url} />
    </>
  );
}
