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
if (document.querySelector("[data-count]")) {
  setInterval(async () => {
    if (document.hidden || document.querySelector("dialog[open]")) return;
    try {
      const data = await api("/overview");
      for (const node of document.querySelectorAll("[data-count]")) {
        node.textContent = data.counts[node.dataset.count] ?? "0";
      }
    } catch { /* API handles an expired session. */ }
  }, 20000);
}
