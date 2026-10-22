import { Gateway, optionsFromArgs, recordGatewayLog } from "./client.ts";
import { StdioServerTransport } from "@mcp/server/stdio";
if (import.meta.main) {
  console.log = console.info = console.debug = (...args: unknown[]) =>
    console.error(...args);
  const gateway = await Gateway.open(optionsFromArgs(Deno.args));
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void gateway.close().catch((error) => {
      recordGatewayLog(
        "error",
        "mcp-gateway",
        `Stdio close failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    });
  };
  gateway.server.onerror = (error) =>
    recordGatewayLog(
      "error",
      "mcp-gateway",
      `Stdio MCP transport error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  await gateway.server.connect(transport);
  const shutdown = async () => {
    try {
      recordGatewayLog("info", "mcp-gateway", "Stdio shutdown started");
      await gateway.close();
      await gateway.server.close();
      recordGatewayLog("info", "mcp-gateway", "Stdio shutdown completed");
    } catch (error) {
      recordGatewayLog(
        "error",
        "mcp-gateway",
        `Stdio shutdown failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  }
}
