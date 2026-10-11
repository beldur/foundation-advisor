import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
/** The game connects here. Must match PORT in bridge/bridge.lua. */
export const BRIDGE_PORT = 47800;
/** Local tools (the eval CLI, later the dashboard) talk to the server here. */
export const HTTP_PORT = 47801;

export const PROJECT_DIR = join(import.meta.dirname, "..", "..");
export const DUMP_DIR = join(PROJECT_DIR, "docs", "dumps");
export const GAME_DIR = "C:/Program Files (x86)/Steam/steamapps/common/Foundation";
export const USER_DIR = join(homedir(), "Documents", "Polymorph Games", "Foundation");
export const MODDEV_DIR = join(USER_DIR, "moddev");
/** Local mods live here; the game lists them in its Mods menu. */
export const MOD_DIR = join(USER_DIR, "mods", "Companion Bridge");
