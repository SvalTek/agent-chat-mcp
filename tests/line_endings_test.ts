import { assertEquals } from "@std/assert";
import { join } from "node:path";

// The normal test task permits only Deno subprocesses. Opt in to these Git
// integration tests by also passing --allow-run=deno,git to `deno test`.
const canRunGit = Deno.permissions.querySync({
  name: "run",
  command: "git",
}).state === "granted";

for (const autocrlf of ["true", "input", "false"]) {
  Deno.test({
    name:
      `line endings: checkout preserves LF text and binary bytes with core.autocrlf=${autocrlf}`,
    ignore: !canRunGit,
    async fn(t) {
      const dir = await Deno.makeTempDir({ prefix: "agent-chat-eol-test-" });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      async function git(...args: string[]) {
        const result = await new Deno.Command("git", {
          args,
          cwd: dir,
          env: {
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: join(dir, "empty.gitconfig"),
          },
          signal: controller.signal,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(result.code, 0, decoder.decode(result.stderr));
        return result.stdout;
      }
      const fixtures = [
        { path: "README.md", text: "first\r\nsecond\r\n" },
        { path: "nested/source.ts", text: 'const name = "café 🐇";\r\n' },
        { path: ".env.example", text: "NAME=value\r\n" },
        { path: "nested/no-extension", text: "first\r\nlast" },
        { path: "already-lf.txt", text: "first\nsecond\n" },
        { path: "empty.txt", text: "" },
      ].map(({ path, text }) => ({
        path,
        input: encoder.encode(text),
        expected: encoder.encode(text.replaceAll("\r\n", "\n")),
      }));
      // A NUL byte makes Git classify this as binary even with a text extension.
      const binary = new Uint8Array([0, 13, 10, 255, 10, 13, 10, 0]);
      fixtures.push({ path: "binary.txt", input: binary, expected: binary });
      try {
        await Deno.writeTextFile(join(dir, "empty.gitconfig"), "");
        await git("init", "--quiet");
        await git("config", "core.autocrlf", autocrlf);
        await git("config", "core.safecrlf", "false");
        await Deno.copyFile(
          new URL("../.gitattributes", import.meta.url),
          join(dir, ".gitattributes"),
        );
        await Deno.mkdir(join(dir, "nested"));
        for (const fixture of fixtures) {
          await Deno.writeFile(join(dir, fixture.path), fixture.input);
        }
        await git(
          "add",
          "--",
          ".gitattributes",
          ...fixtures.map((f) => f.path),
        );
        // Remove the originals so Git cannot reuse their cached stat data.
        for (const fixture of fixtures) {
          await Deno.remove(join(dir, fixture.path));
        }
        // Materialize the files through Git's checkout filters, as on a new clone.
        await git(
          "checkout-index",
          "--force",
          "--",
          ...fixtures.map((f) => f.path),
        );
        for (const fixture of fixtures) {
          await t.step(fixture.path, async () => {
            assertEquals(
              await git("show", ":" + fixture.path),
              fixture.expected,
              "The indexed content must be normalized without changing binary data",
            );
            assertEquals(
              await Deno.readFile(join(dir, fixture.path)),
              fixture.expected,
              "Checkout must use LF regardless of core.autocrlf",
            );
          });
        }
      } finally {
        clearTimeout(timeout);
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}
