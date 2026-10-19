import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";

const { tasks } = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { tasks: Record<string, string> };

// Exercise the real task commands with disposable entry points. This checks
// that Deno receives the option, rather than passing it to the application.
const abortProbe = `
async function probe() {
  let completedSignal: AbortSignal | undefined;
  const disconnected = Promise.withResolvers<boolean>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (new URL(request.url).pathname === "/complete") {
        completedSignal = request.signal;
        return new Response("complete");
      }
      request.signal.addEventListener("abort", () => {
        disconnected.resolve(request.signal.aborted);
      }, { once: true });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("pending"));
        },
      }));
    },
  );
  let connection: Deno.TcpConn | undefined;
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.addr.port + "/complete",
    );
    if (await response.text() !== "complete") {
      throw new Error("The response did not complete");
    }
    connection = await Deno.connect({
      hostname: "127.0.0.1", port: server.addr.port,
    });
    await connection.write(new TextEncoder().encode(
      "GET /disconnect HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n",
    ));
    if (await connection.read(new Uint8Array(4096)) === null) {
      throw new Error("The streaming response did not start");
    }
    connection.close();
    connection = undefined;
    if (await disconnected.promise !== true) {
      throw new Error("A client disconnect did not abort request.signal");
    }
    // The second request ensures the server has finished the first response.
    if (completedSignal?.aborted !== false) {
      throw new Error("A successful response aborted request.signal");
    }
    console.log("abort-semantics-ok");
  } finally {
    connection?.close();
    await server.shutdown();
  }
}
`;

for (
  const [task, entrypoint] of [
    ["start", "main.ts"],
    ["http", "http.ts"],
    ["stdio", "stdio.ts"],
    ["test", "tests/abort_test.ts"],
  ]
) {
  Deno.test(`task configuration: ${task} uses corrected request abort semantics`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "agent-chat-task-test-" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      assert(tasks[task], `The ${task} task must exist`);
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ tasks: { [task]: tasks[task] } }),
      );
      await Deno.mkdir(join(dir, "tests"));
      await Deno.writeTextFile(
        join(dir, entrypoint),
        abortProbe +
          (task === "test"
            ? '\nDeno.test("request abort semantics", probe);\n'
            : "\nawait probe();\n"),
      );
      const result = await new Deno.Command("deno", {
        args: ["task", "--config", join(dir, "deno.json"), task],
        cwd: dir,
        env: { NO_COLOR: "1" },
        signal: controller.signal,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      assertEquals(result.code, 0, `${task}: ${stdout}\n${stderr}`);
      assert(stdout.includes("abort-semantics-ok"), stdout);
      assert(
        !/deprecat|legacy.abort/i.test(
          stderr.split("\n").filter((line) => !line.startsWith("Task ")).join(
            "\n",
          ),
        ),
        stderr,
      );
    } finally {
      clearTimeout(timeout);
      await Deno.remove(dir, { recursive: true });
    }
  });
}
