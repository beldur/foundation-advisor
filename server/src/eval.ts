// Runs Lua inside the game through the bridge server.
//   pnpm eval "return __bridge.status()"
//   pnpm eval -f scripts/probe.lua
import { readFile } from "node:fs/promises";
import { HOST, HTTP_PORT } from "./config.ts";

const args = process.argv.slice(2);
const code = args[0] === "-f" && args[1] ? await readFile(args[1], "utf8") : args.join(" ");
if (!code.trim()) {
  console.error('usage: pnpm eval "<lua>"  |  pnpm eval -f <file.lua>');
  process.exit(2);
}

let result: { ok: boolean; values?: unknown[]; error?: string };
try {
  const response = await fetch(`http://${HOST}:${HTTP_PORT}/eval`, { method: "POST", body: code });
  result = await response.json();
} catch {
  console.error("bridge server is not running (start it with: pnpm server)");
  process.exit(1);
}

if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
for (const value of result.values ?? []) console.log(JSON.stringify(value, null, 2));
