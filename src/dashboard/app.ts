import { Hono } from "hono";
import type { AdminServices } from "../admin/service.ts";
import { dashboardPages } from "./routes/pages.tsx";
import { adminApi } from "./routes/api.ts";
export function createDashboard(admin: AdminServices) {
  const app = new Hono();
  app.route("/api/admin/v1", adminApi(admin));
  app.route("/", dashboardPages(admin));
  return app;
}
