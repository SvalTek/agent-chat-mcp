import { chromium } from "playwright";
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { BoardStore } from "../src/domain/board.ts";
import { AuthService } from "../src/auth/service.ts";
import { createApp } from "../src/app.ts";

// Browser acceptance check against disposable storage; never touches a running board.
const directory = await Deno.makeTempDir({ prefix: "agent-chat-browser-" });
const store = await BoardStore.open(join(directory, "board.kv"));
const auth = new AuthService(store, {
  secret: "disposable-browser-check-secret-at-least-32-characters",
});
const app = createApp({ store, auth });
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  app.app.fetch,
);
const browser = await chromium.launch({
  executablePath: Deno.env.get("PLAYWRIGHT_EXECUTABLE_PATH") ??
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  const a = { id: "design", accountId: null, lastMessageId: null };
  const b = { id: "review", accountId: null, lastMessageId: null };
  await store.authenticate(a, "architect", "temporary agent password");
  await store.authenticate(b, "reviewer", "temporary agent password");
  const category = await store.createCategory(a, "Engineering");
  await store.postThread(
    a,
    category.id,
    "API integration review: the contracts are ready. @reviewer",
  );
  await store.sendDm(
    a,
    "reviewer",
    "Can you review the integration permissions before release?",
  );
  const output = Deno.env.get("DASHBOARD_SCREENSHOTS") ??
    join(directory, "screenshots");
  await Deno.mkdir(output, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.addr.port}`;
  await page.goto(base);
  await page.locator('[name="username"]').fill("admin");
  await page.locator('[name="password"]').fill("change-me");
  await Promise.all([
    page.waitForURL(base + "/"),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await page.screenshot({ path: join(output, "overview.png"), fullPage: true });
  for (
    const path of [
      "/conversations",
      "/categories",
      "/agents",
      "/activity",
      "/sessions",
      "/logs",
      "/settings",
    ]
  ) {
    assertEquals((await page.goto(base + path))?.status(), 200);
  }
  await page.locator('[name="currentPassword"]').fill("change-me");
  await page.locator('[name="newPassword"]').fill("browser owner password");
  await page.getByRole("button", { name: "Change owner password" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(base + "/access");
  await page.getByRole("button", { name: "New integration" }).click();
  await page.locator('[name="clientId"]').fill("build_worker");
  await page.getByRole("button", { name: "Create integration", exact: true })
    .click();
  await page.locator("#token-dialog").waitFor({ state: "visible" });
  const token = await page.locator("#created-token").inputValue();
  assertEquals(token.length, 64);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Done", exact: true }).click(),
  ]);
  assert(
    await page.getByRole("link", { name: "build_worker", exact: true })
      .isVisible(),
  );
  await page.screenshot({
    path: join(output, "integrations.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Change access", exact: true })
    .click();
  await page.locator('[name="accessLevel"]').selectOption("admin");
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#action-submit").click(),
  ]);
  assert(await page.getByText("admin", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Rotate token", exact: true }).click();
  await page.locator("#action-submit").click();
  await page.locator("#token-dialog").waitFor({ state: "visible" });
  assert(token !== await page.locator("#created-token").inputValue());
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Done", exact: true }).click(),
  ]);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#action-submit").click(),
  ]);
  assert(await page.getByText("Revoked", { exact: true }).first().isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.locator('[aria-label="Open navigation"]').click();
  assert(await page.locator("#sidebar-toggle").isChecked());
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  assertEquals(errors, []);
  console.log("Browser checks passed. Screenshots: " + output);
} finally {
  await browser.close();
  await server.shutdown();
  await app.close();
  store.close();
  await Deno.remove(directory, { recursive: true });
}
