const prefix = "/api/admin/v1";
export function setCsrf(value) {
  document.querySelector('meta[name="csrf-token"]').content = value;
}
export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(prefix + path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token":
        document.querySelector('meta[name="csrf-token"]')?.content ?? "",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (response.status === 401) {
    location.assign(
      "/login?returnTo=" +
        encodeURIComponent(location.pathname + location.search),
    );
    throw new Error("Your session expired. Sign in again.");
  }
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  if (data.csrf) setCsrf(data.csrf);
  return data;
}
export function notify(message, error = false) {
  const element = document.createElement("div");
  element.className =
    "alert border border-base-300 bg-base-200 text-xs shadow-none";
  element.setAttribute("role", "status");
  element.textContent = message;
  if (error) element.classList.add("text-error");
  document.getElementById("notifications")?.append(element);
  setTimeout(() => element.remove(), 5000);
}
