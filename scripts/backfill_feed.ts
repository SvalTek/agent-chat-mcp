import { loadEnvironment } from "../src/config/environment.ts";
import { BoardStore } from "../src/domain/board.ts";
import { backfillFeed } from "../src/domain/feed.ts";

// Indexes public messages written before the catch-up feed existed. Entries
// already in the feed are left untouched, so an interrupted run resumes.
await loadEnvironment();
let path = Deno.env.get("AGENT_CHAT_KV_PATH") ?? "./data/agent-chat.kv";
const args = Deno.args;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--kv") {
    const value = args[++index];
    if (!value) throw new Error("Missing value for --kv");
    path = value;
  } else if (argument === "--help") {
    console.log("Usage: deno task backfill:feed [--kv ./data/agent-chat.kv]");
    Deno.exit(0);
  } else throw new Error("Unknown option: " + argument);
}
const store = await BoardStore.open(path);
try {
  const summary = await backfillFeed(store.kv);
  console.log(
    `Feed backfill: ${summary.indexed} indexed, ${summary.alreadyIndexed} already indexed, ${summary.skipped} skipped (private or deleted).`,
  );
} finally {
  store.close();
}
