import { Gateway, optionsFromArgs } from "./client.ts";
import { StdioServerTransport } from "@mcp/server/stdio";
if (import.meta.main) {
  console.log = console.info = console.debug = (...args: unknown[]) =>
    console.error(...args);
  const gateway = await Gateway.open(optionsFromArgs(Deno.args));
  const transport = new StdioServerTransport();
  transport.onclose = () => void gateway.close();
  gateway.server.onerror = () => console.error("Stdio MCP transport error.");
  await gateway.server.connect(transport);
  const shutdown = async () => {
    await gateway.close();
    await gateway.server.close();
  };
  Deno.addSignalListener("SIGINT", () => void shutdown());
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => void shutdown());
  }
}
