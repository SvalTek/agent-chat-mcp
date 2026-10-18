import { parse } from "@std/dotenv";

/** Load an optional working-directory .env without overriding the process environment. */
export async function loadEnvironment(path = ".env") {
  let source: string;
  try {
    source = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const [key, value] of Object.entries(parse(source))) {
    if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
  }
}
