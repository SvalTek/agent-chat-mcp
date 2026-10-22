import { api, notify } from "./api.js";
const dialog = document.getElementById("action-dialog");
let current;
export function openAction(config) {
  current = config;
  document.getElementById("action-title").textContent = config.title;
  document.getElementById("action-description").textContent =
    config.description ?? "";
  document.getElementById("action-error").textContent = "";
  const container = document.getElementById("action-fields");
  container.replaceChildren();
  for (const field of config.fields ?? []) {
    const label = document.createElement("label");
    label.className = "fieldset gap-2 py-2";
    const title = document.createElement("span");
    title.className = "text-xs text-base-content/60";
    title.textContent = field.label;
    const input = document.createElement(
      field.type === "textarea"
        ? "textarea"
        : field.options
        ? "select"
        : "input",
    );
    input.name = field.name;
    input.className = (field.type === "textarea"
      ? "textarea min-h-40"
      : field.options
      ? "select"
      : "input") + " w-full bg-base-100";
    input.required = field.required !== false;
    if (input.tagName === "INPUT") {
      input.type = field.type ?? "text";
      if (field.type === "password") {
        input.autocomplete = "new-password";
      }
      if (field.type === "number") {
        input.min = "1";
        input.max = String(field.max ?? 365);
      }
    }
    if (field.options) {
      for (const [value, text] of field.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
    }
    input.value = field.value ?? "";
    if (field.name === "text") {
      input.maxLength = 20000;
    }
    if (field.name === "description") {
      input.maxLength = 500;
    }
    if (field.name === "password") {
      input.minLength = 10;
    }
    label.append(title, input);
    container.append(label);
  }
  const submit = document.getElementById("action-submit");
  submit.textContent = config.submit ?? "Save changes";
  submit.classList.toggle("btn-error", !!config.danger);
  dialog.showModal();
}
export function showToken(data) {
  const output = document.getElementById("created-token");
  output.value = data.token;
  document.getElementById("token-description").textContent = data.clientId
    ? "Client ID: " + data.clientId +
      ". Use this clientId as the username and the token below as its password. The token is shown only once."
    : "Copy this bearer token now. Only its metadata is stored on the server.";
  document.getElementById("token-dialog").showModal();
}
document.getElementById("action-form")?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    const config = current;
    const button = document.getElementById("action-submit");
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.target));
      const data = await api(config.path, {
        method: config.method ?? "PATCH",
        body: config.method === "DELETE"
          ? undefined
          : config.body
          ? config.body(values)
          : values,
      });
      dialog.close();
      if (data.token) showToken(data);
      else location.assign(config.redirect ?? location.href);
    } catch (error) {
      document.getElementById("action-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  },
);
dialog?.addEventListener("close", () => {
  document.getElementById("action-fields").replaceChildren();
  current = undefined;
});
document.getElementById("token-dialog")?.addEventListener("close", () => {
  document.getElementById("created-token").value = "";
  location.reload();
});
export async function copyToken() {
  const input = document.getElementById("created-token");
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(input.value);
    notify("Token copied.");
  } else {
    input.focus();
    input.select();
    notify("Token selected. Use your browser's copy command.");
  }
}
