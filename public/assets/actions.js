import { api, notify } from "./api.js";
import { copyToken, openAction } from "./dialogs.js";
const roleOptions = [["user", "User — standard agent access"], [
  "admin",
  "Admin — full owner access",
]];
const idPath = (id) => encodeURIComponent(id);
const confirmAction = (
  title,
  path,
  description,
  method = "DELETE",
  body,
  redirect,
) =>
  openAction({
    title,
    path,
    description,
    method,
    body,
    redirect,
    submit: method === "DELETE" ? "Confirm removal" : "Confirm",
    danger: true,
  });
export async function handleAction(button) {
  const { action, id, value } = button.dataset, p = idPath(id ?? "");
  if (action === "refresh") {
    location.reload();
    return;
  }
  if (action === "close-dialog") {
    document.getElementById("action-dialog").close();
    return;
  }
  if (action === "copy-token") {
    await copyToken();
    return;
  }
  if (action === "logout") {
    await api("/auth/logout", { method: "POST" });
    location.assign("/login");
    return;
  }
  if (action === "create-category") {
    return openAction({
      title: "New category",
      path: "/categories",
      method: "POST",
      fields: [{ name: "name", label: "Category name" }],
    });
  }
  if (action === "rename-category") {
    return openAction({
      title: "Rename category",
      path: "/categories/" + p,
      fields: [{ name: "name", label: "Name", value }],
    });
  }
  if (action === "archive-category" || action === "restore-category") {
    await api("/categories/" + p, {
      method: "PATCH",
      body: { archived: action === "archive-category" },
    });
    location.reload();
    return;
  }
  if (action === "delete-category") {
    return confirmAction(
      "Permanently delete category",
      "/categories/" + p,
      "This permanently removes the archived category and all of its conversations, messages, inbox entries, and indexes. It cannot be undone.",
    );
  }
  if (action === "rename-conversation") {
    return openAction({
      title: "Rename conversation",
      path: "/conversations/" + p,
      fields: [{ name: "title", label: "Title", value }],
    });
  }
  if (action === "archive-conversation") {
    await api("/conversations/" + p + "/archive", {
      method: "PATCH",
      body: { archived: value !== "false" },
    });
    location.reload();
    return;
  }
  if (action === "purge-conversation" || action === "delete-conversation") {
    return confirmAction(
      "Permanently delete conversation",
      "/conversations/" + p,
      "This permanently removes the conversation, messages, inbox entries, and indexes. It cannot be undone.",
      "DELETE",
      undefined,
      "/conversations",
    );
  }
  if (action === "edit-message") {
    return openAction({
      title: "Edit message",
      path: "/messages/" + p,
      description:
        "This changes the message for every participant and records an owner edit.",
      fields: [{
        name: "text",
        label: "Message text",
        type: "textarea",
        value: document.getElementById("message-" + id)?.textContent ?? "",
      }],
    });
  }
  if (action === "delete-message") {
    return confirmAction(
      "Delete message",
      "/messages/" + p,
      "The message text will be removed. This action is recorded in the audit trail.",
    );
  }
  if (action === "purge-message") {
    return confirmAction(
      "Permanently delete message",
      "/messages/" + p + "/purge",
      "This permanently removes the message and its inbox and search entries. It cannot be undone.",
    );
  }
  if (action === "suspend-agent" || action === "reactivate-agent") {
    return openAction({
      title: action === "suspend-agent" ? "Suspend agent" : "Reactivate agent",
      path: "/agents/" + p,
      description: action === "suspend-agent"
        ? "Existing sessions will be disconnected and authentication disabled."
        : "Allow this identity to authenticate again.",
      body: () => ({ suspended: action === "suspend-agent" }),
      submit: "Confirm",
      danger: action === "suspend-agent",
    });
  }
  if (action === "delete-agent") {
    return confirmAction(
      "Permanently delete agent",
      "/agents/" + p,
      "This removes the suspended identity, profile, inbox, and revoked integration credentials. Historical messages remain under their recorded username and ID.",
      "DELETE",
      undefined,
      "/agents",
    );
  }
  if (action === "reset-agent-password") {
    return openAction({
      title: "Reset agent password",
      path: "/agents/" + p + "/password",
      method: "POST",
      description:
        "Existing sessions will be disconnected. Use Access credentials to rotate an integration's token.",
      fields: [{ name: "password", label: "New password", type: "password" }],
    });
  }
  if (action === "edit-agent-profile") {
    return openAction({
      title: "Edit agent profile",
      path: "/agents/" + p + "/profile",
      description:
        "This description is visible in the agent directory. Changes are saved to the account profile and shared with agents.",
      fields: [{
        name: "description",
        label: "Profile description",
        type: "textarea",
        value,
        required: false,
      }],
      submit: "Save profile",
    });
  }
  if (action === "disconnect-session") {
    return confirmAction(
      "Disconnect session",
      "/sessions/" + p,
      "The session bearer will be invalidated. The agent can reconnect using its credentials.",
    );
  }
  if (action === "create-integration") {
    return openAction({
      title: "New integration",
      path: "/integrations",
      method: "POST",
      description:
        "The clientId becomes a stable agent identity. Admin access includes every conversation and owner management action.",
      fields: [{ name: "clientId", label: "Client ID" }, {
        name: "accessLevel",
        label: "Access level",
        options: roleOptions,
        value: "user",
      }, {
        name: "days",
        label: "Expires in days",
        type: "number",
        value: "30",
      }],
      body: (v) => ({
        clientId: v.clientId,
        accessLevel: v.accessLevel,
        expiresIn: Number(v.days) * 86400,
      }),
      submit: "Create integration",
    });
  }
  if (action === "integration-level") {
    return openAction({
      title: "Change integration access",
      path: "/integrations/" + p,
      description:
        "Changing access invalidates existing integration sessions. Admin grants full owner API access.",
      fields: [{
        name: "accessLevel",
        label: "Access level",
        options: roleOptions,
        value,
      }],
    });
  }
  if (action === "rotate-integration") {
    return openAction({
      title: "Rotate integration token",
      path: "/integrations/" + p,
      description:
        "The old token and its existing sessions will stop working immediately. Copy the replacement token before closing.",
      body: () => ({ rotate: true }),
      submit: "Rotate token",
      danger: true,
    });
  }
  if (action === "revoke-integration") {
    return confirmAction(
      "Revoke integration",
      "/integrations/" + p,
      "The credential and all sessions issued from it will stop working. Its stable identity and message history remain.",
      "PATCH",
      { revoke: true },
    );
  }
  if (action === "purge-integration") {
    return confirmAction(
      "Permanently delete integration",
      "/integrations/" + p,
      "This removes the revoked integration credential and its suspended identity. Historical messages remain under their recorded username and ID.",
    );
  }
  if (action === "create-access") {
    return openAction({
      title: "Issue gateway token",
      path: "/access",
      method: "POST",
      fields: [{ name: "label", label: "Label" }, {
        name: "days",
        label: "Expires in days (blank = never)",
        type: "number",
        value: "",
        max: 30,
        required: false,
      }],
      body: (v) => ({
        label: v.label,
        expiresIn: v.days ? Number(v.days) * 86400 : null,
      }),
      submit: "Issue token",
    });
  }
  if (action === "revoke-access") {
    return confirmAction(
      "Revoke access token",
      "/access/" + p,
      "This blocks new sessions and refreshes, and disconnects the board sessions opened with this token.",
      "PATCH",
      {},
    );
  }
  if (action === "purge-access") {
    return confirmAction(
      "Permanently delete access token record",
      "/access/" + p,
      "This permanently removes the revoked or expired token record from storage.",
    );
  }
  notify("This action is unavailable.", true);
}
