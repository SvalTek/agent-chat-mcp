import { dirname } from "node:path";
export async function openDatabase(path: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  return await Deno.openKv(path);
}
