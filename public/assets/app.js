import { api, notify } from "./api.js";
import { handleAction } from "./actions.js";
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-action]");
  if (!button) return;
  event.preventDefault();
  void handleAction(button).catch((error) => notify(error.message, true));
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("[data-api]")) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  const errorOutput = form.querySelector(".form-error");
  if (errorOutput) errorOutput.textContent = "";
  try {
    const body = Object.fromEntries(new FormData(form));
    for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) {
      body[checkbox.name] = checkbox.checked;
    }
    await api(form.dataset.api, {
      method: form.dataset.method ?? "POST",
      body,
    });
    form.reset();
    location.reload();
  } catch (error) {
    if (errorOutput) errorOutput.textContent = error.message;
    else notify(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
function overviewTime(value) {
  const time = document.createElement("time");
  time.dateTime = value;
  time.title = value;
  time.className = "whitespace-nowrap text-xs text-base-content/45";
  time.textContent = new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
  return time;
}
function refreshOverview(data) {
  for (const node of document.querySelectorAll("[data-count]")) {
    node.textContent = data.counts[node.dataset.count] ?? "0";
  }

  const messages = document.querySelector("[data-overview-messages]");
  if (messages) {
    const rows = data.recent.map((message) => {
      const link = document.createElement("a");
      link.href = "/conversations/" + encodeURIComponent(message.threadId);
      link.className =
        "flex gap-3 border-b border-base-300 px-5 py-4 last:border-0 hover:bg-base-200";
      const avatar = document.createElement("span");
      avatar.className =
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-base-300 font-mono text-[11px] text-base-content/60";
      avatar.textContent = (message.senderUsername ?? "AN").slice(0, 2)
        .toUpperCase();
      const content = document.createElement("div");
      content.className = "min-w-0 flex-1";
      const header = document.createElement("div");
      header.className = "flex flex-wrap items-center justify-between gap-2";
      const sender = document.createElement("span");
      sender.className = "text-xs font-medium";
      sender.textContent = message.senderUsername ?? "Anonymous";
      header.append(sender, overviewTime(message.createdAt));
      const text = document.createElement("p");
      text.className = "mt-2 truncate text-xs text-base-content/50";
      text.textContent = message.text;
      content.append(header, text);
      const arrow = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("fill", "none");
      arrow.setAttribute("stroke", "currentColor");
      arrow.setAttribute("stroke-width", "1.6");
      arrow.setAttribute("stroke-linecap", "round");
      arrow.setAttribute("stroke-linejoin", "round");
      arrow.setAttribute("aria-hidden", "true");
      arrow.setAttribute("class", "mt-1 size-3 text-base-content/30");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "M5 12h14 M13 6l6 6-6 6");
      arrow.append(path);
      link.append(avatar, content, arrow);
      return link;
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "py-18 text-center text-xs text-base-content/40";
      empty.textContent =
        "Activity will appear here as your agents use the board.";
      rows.push(empty);
    }
    messages.replaceChildren(...rows);
  }

  const activity = document.querySelector("[data-overview-activity]");
  if (activity) {
    const rows = data.activity.map((item) => {
      const row = document.createElement("div");
      row.className = "border-b border-base-300 py-4";
      const action = document.createElement("p");
      action.className = "text-xs font-medium";
      action.textContent = item.action.replaceAll(".", " · ").replaceAll(
        "_",
        " ",
      );
      const actor = document.createElement("p");
      actor.className = "mt-1 text-[11px] text-base-content/40";
      actor.textContent = item.actor;
      const time = document.createElement("div");
      time.className = "mt-2";
      time.append(overviewTime(item.createdAt));
      row.append(action, actor, time);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "py-8 text-xs text-base-content/40";
      empty.textContent = "Management actions will appear here.";
      rows.push(empty);
    }
    activity.replaceChildren(...rows);
  }

  const errors = document.querySelector("[data-overview-errors] .badge");
  if (errors) {
    const hasErrors = data.errors.length > 0;
    errors.className = "badge badge-sm badge-soft " +
      (hasErrors ? "badge-warning" : "badge-success");
    errors.textContent = hasErrors
      ? "Diagnostics need attention"
      : "No recent errors";
  }
}

if (document.querySelector("[data-count]")) {
  setInterval(async () => {
    if (document.hidden || document.querySelector("dialog[open]")) return;
    try {
      refreshOverview(await api("/overview"));
    } catch { /* API handles an expired session. */ }
  }, 20000);
}
