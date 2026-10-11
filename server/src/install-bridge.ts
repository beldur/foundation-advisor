// Copies the bridge into the game's user folder. The game loads it on next start.
//   pnpm install-bridge            install or update
//   pnpm install-bridge --remove   uninstall
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MOD_DIR, MODDEV_DIR, PROJECT_DIR } from "./config.ts";

const script = join(MODDEV_DIR, "bridge.lua");

if (process.argv.includes("--remove")) {
  await rm(script, { force: true });
  await rm(MOD_DIR, { recursive: true, force: true });
  console.log(`removed ${script}`);
  console.log(`removed ${MOD_DIR}`);
} else {
  await mkdir(MODDEV_DIR, { recursive: true });
  await copyFile(join(PROJECT_DIR, "bridge", "bridge.lua"), script);
  await cp(join(PROJECT_DIR, "bridge", "mod"), MOD_DIR, { recursive: true });
  console.log(`installed ${script}`);
  console.log(`installed ${MOD_DIR}`);
  console.log("restart Foundation for them to load");
}
